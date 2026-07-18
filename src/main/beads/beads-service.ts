import {
  hostPath,
  hostPathEquals,
  type BeadIssue,
  type BeadsChangedEvent,
  type BeadsListRequest,
  type BeadsListResponse,
  type BeadsProbeResponse,
  type BeadsUnavailable,
  type Disposer,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'

/** aoa's full export is ~760 KB; leave two orders of magnitude of headroom. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
/** Dolt touches several files per mutation; coalesce bursts into one event. */
const WATCH_DEBOUNCE_MS = 250
/** Watches are per-subscribed-workspace; the panel holds at most one. */
const MAX_WATCHES = 8

export interface BeadsServiceDeps {
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
  readonly emitChanged: (event: BeadsChangedEvent) => void
}

interface BeadsWatchEntry {
  readonly root: HostPath
  readonly stop: Disposer
  timer: ReturnType<typeof setTimeout> | undefined
  /** Watch backends may deliver events already in flight after stop. */
  stopped: boolean
}

/**
 * Read-only bridge to the `bd` CLI for the active workspace. Lives entirely
 * behind the `ProjectHost` seam, so beads render for local and SSH projects
 * alike wherever `bd` is installed.
 */
export class BeadsService {
  private readonly watches = new Map<string, BeadsWatchEntry>()

  constructor(private readonly deps: BeadsServiceDeps) {}

  async list(req: BeadsListRequest): Promise<BeadsListResponse> {
    const { host, root } = this.activeProject(req.root)
    const [base, ready] = await Promise.all([
      this.runList(host, root, []),
      this.runList(host, root, ['--ready']),
    ])
    if (!base.ok) return base.unavailable
    if (!ready.ok) return ready.unavailable
    let closedIssues: readonly BeadIssue[] | undefined
    if (req.includeClosed === true) {
      const closed = await this.runList(host, root, ['--status', 'closed'])
      if (!closed.ok) return closed.unavailable
      closedIssues = closed.issues
    }
    return {
      available: true,
      issues: base.issues,
      readyIds: ready.issues.map((issue) => issue.id),
      ...(closedIssues ? { closedIssues } : {}),
    }
  }

  /**
   * Does the active workspace have a beads project? A `.beads` directory stat —
   * no `bd`, no server — so the rail can hide the Beads tab for plain
   * directories the same way it hides Git for non-repositories. A workspace
   * with a `.beads` directory but an unreachable server still counts (the tab
   * shows, then reports the actionable connection error).
   */
  async probe(requestedRoot: HostPath): Promise<BeadsProbeResponse> {
    const { host, root } = this.activeProject(requestedRoot)
    try {
      const stat = await host.stat(joinRoot(root, '.beads'))
      return { hasProject: stat.type === 'dir' }
    } catch {
      return { hasProject: false }
    }
  }

  /** Watch `.beads/` under the active workspace and push change events. */
  async watch(requestedRoot: HostPath): Promise<void> {
    const { host, root } = this.activeProject(requestedRoot)
    const key = watchKey(root)
    if (this.watches.has(key)) return
    const beadsDirectory = joinRoot(root, '.beads')
    try {
      const stat = await host.stat(beadsDirectory)
      if (stat.type !== 'dir') return
    } catch {
      // No .beads directory: nothing to watch. A manual refresh (or reopening
      // the panel) picks up a database created later.
      return
    }
    if (this.watches.size >= MAX_WATCHES) {
      const oldest = this.watches.keys().next().value
      if (oldest !== undefined) this.stopWatch(oldest)
    }
    const entry: BeadsWatchEntry = {
      root,
      timer: undefined,
      stopped: false,
      stop: host.watch(
        beadsDirectory,
        () => {
          if (entry.stopped) return
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => {
            entry.timer = undefined
            this.deps.emitChanged({ root: entry.root })
          }, WATCH_DEBOUNCE_MS)
        },
        {
          recursive: false,
          onError: (error) => console.error('[beads] watcher failed', error),
        },
      ),
    }
    this.watches.set(key, entry)
  }

  unwatch(requestedRoot: HostPath): void {
    if (!isHostPathShape(requestedRoot)) return
    this.stopWatch(watchKey(requestedRoot))
  }

  dispose(): void {
    for (const key of [...this.watches.keys()]) this.stopWatch(key)
  }

  /**
   * The panel only ever asks about the active workspace; anything else is
   * rejected before a path reaches exec or watch. The trusted registry root is
   * used from here on, never the renderer-supplied value.
   */
  private activeProject(requested: HostPath): {
    readonly host: ProjectHost
    readonly root: HostPath
  } {
    const project = this.deps.getProject()
    if (!isHostPathShape(requested) || !hostPathEquals(requested, project.root)) {
      throw new Error('Beads requests are limited to the active workspace root')
    }
    return project
  }

  private async runList(
    host: ProjectHost,
    root: HostPath,
    extraArgs: readonly string[],
  ): Promise<
    | { readonly ok: true; readonly issues: readonly BeadIssue[] }
    | { readonly ok: false; readonly unavailable: BeadsUnavailable }
  > {
    const args = [
      '-C',
      root.path,
      'list',
      '--json',
      '--flat',
      '--no-pager',
      '-n',
      '0',
      ...extraArgs,
    ]
    let result
    try {
      // `bd` is a user-installed CLI that commonly lives in ~/.local/bin, which
      // a non-login shell (SSH exec) or a GUI-launched app's minimal PATH does
      // not include. Route through the host's login shell so it resolves the
      // same way it does in an interactive terminal — PATH and any
      // BEADS_DOLT_* overrides included. The full environment is inherited (no
      // unsetEnv), so port resolution matches the terminal.
      result = await host.exec('bd', args, {
        maxBuffer: MAX_OUTPUT_BYTES,
        loginShell: true,
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const missing = /ENOENT|not found/i.test(message)
      logBeadsFailure(root, args, { thrown: message })
      return {
        ok: false,
        unavailable: {
          available: false,
          reason: missing ? 'bd-missing' : 'error',
          message: missing ? 'The bd CLI is not installed on this host.' : message,
        },
      }
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      logBeadsFailure(root, args, { code: result.code, stderr })
      return { ok: false, unavailable: classifyListFailure(root, stderr, result.code) }
    }
    try {
      return { ok: true, issues: parseBeadsListOutput(result.stdout) }
    } catch (reason) {
      return {
        ok: false,
        unavailable: {
          available: false,
          reason: 'error',
          message: reason instanceof Error ? reason.message : String(reason),
        },
      }
    }
  }

  private stopWatch(key: string): void {
    const entry = this.watches.get(key)
    if (!entry) return
    this.watches.delete(key)
    entry.stopped = true
    if (entry.timer) clearTimeout(entry.timer)
    try {
      void Promise.resolve(entry.stop()).catch((reason) =>
        console.error('[beads] failed to stop watcher', reason),
      )
    } catch (reason) {
      console.error('[beads] failed to stop watcher', reason)
    }
  }
}

/** bd could not find a beads project/database under the requested root. */
const NO_DATABASE = /no beads project found|no database found/i
/**
 * bd found a database configured for a Dolt server it cannot reach. The
 * hallmark is an unresolved port (`127.0.0.1:0`), but bd phrases the same
 * failure several ways depending on why the port never resolved.
 */
const SERVER_UNREACHABLE =
  /127\.0\.0\.1:0\b|:0: connect|dolt server (unreachable|is not running|not reachable)|not reachable \(external\)|auto-start is (disabled|suppressed)|externally managed/i

/**
 * Turn a non-zero `bd list` into a typed, actionable unavailability. The
 * server-unreachable case is called out specifically because its raw stderr
 * ("dial tcp 127.0.0.1:0: connect: connection refused") tells a user nothing
 * about the real fix — a missing or invalid `.beads/dolt-server.port`.
 */
export function classifyListFailure(
  root: HostPath,
  stderr: string,
  code: number | null,
): BeadsUnavailable {
  if (NO_DATABASE.test(stderr)) {
    return {
      available: false,
      reason: 'no-database',
      message: 'No beads database in this project.',
    }
  }
  if (SERVER_UNREACHABLE.test(stderr)) {
    const detail = firstLine(stderr)
    return {
      available: false,
      reason: 'server-unreachable',
      message:
        `Beads Dolt server is not reachable — bd could not resolve a server port. ` +
        `Check that ${root.path}/.beads/dolt-server.port exists and holds the shared ` +
        `Dolt port, or set BEADS_DOLT_SERVER_PORT.` +
        (detail ? ` (bd: ${detail})` : ''),
    }
  }
  return {
    available: false,
    reason: 'error',
    message: stderr || `bd exited with code ${code}`,
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/**
 * Log the workspace root, the exact `bd` argv, and the exit code + stderr on a
 * failed `bd list`. Deliberately never logs stdout (issue data) — only the
 * command and its error channel, which carry no credentials.
 */
function logBeadsFailure(
  root: HostPath,
  args: readonly string[],
  outcome: { readonly code?: number | null; readonly stderr?: string; readonly thrown?: string },
): void {
  console.error('[beads] bd list failed', {
    host: root.hostId,
    root: root.path,
    command: 'bd (login shell)',
    argv: args.join(' '),
    ...(outcome.thrown !== undefined ? { error: outcome.thrown } : {}),
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    ...(outcome.stderr ? { stderr: outcome.stderr } : {}),
  })
}

/** Parse `bd list --json` output; exported for tests. */
export function parseBeadsListOutput(stdout: string): readonly BeadIssue[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new Error('bd returned output that is not valid JSON')
  }
  if (!Array.isArray(raw)) throw new Error('bd returned JSON that is not an issue list')
  return raw.map((candidate, index) => parseBeadIssue(candidate, index))
}

function parseBeadIssue(candidate: unknown, index: number): BeadIssue {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`bd issue at index ${index} is not an object`)
  }
  const record = candidate as Record<string, unknown>
  const id = record['id']
  const title = record['title']
  const status = record['status']
  if (typeof id !== 'string' || id === '') {
    throw new Error(`bd issue at index ${index} is missing an id`)
  }
  if (typeof title !== 'string' || typeof status !== 'string') {
    throw new Error(`bd issue '${id}' is missing a title or status`)
  }
  const labelsRaw = record['labels']
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw.filter((label): label is string => typeof label === 'string')
    : []
  return {
    id,
    title,
    status,
    priority: numberField(record, 'priority', 4),
    issueType: stringField(record, 'issue_type') ?? 'task',
    assignee: stringField(record, 'assignee'),
    labels,
    description: stringField(record, 'description'),
    design: stringField(record, 'design'),
    acceptanceCriteria: stringField(record, 'acceptance_criteria'),
    notes: stringField(record, 'notes'),
    parent: stringField(record, 'parent'),
    createdAt: stringField(record, 'created_at'),
    updatedAt: stringField(record, 'updated_at'),
    closedAt: stringField(record, 'closed_at'),
    closeReason: stringField(record, 'close_reason'),
    dependencyCount: numberField(record, 'dependency_count', 0),
    dependentCount: numberField(record, 'dependent_count', 0),
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isHostPathShape(candidate: unknown): candidate is HostPath {
  if (!candidate || typeof candidate !== 'object') return false
  const record = candidate as Record<string, unknown>
  return typeof record['hostId'] === 'string' && typeof record['path'] === 'string'
}

function watchKey(root: HostPath): string {
  return `${root.hostId}:${root.path}`
}

function joinRoot(root: HostPath, name: string): HostPath {
  return hostPath(root.hostId, root.path === '/' ? `/${name}` : `${root.path}/${name}`)
}
