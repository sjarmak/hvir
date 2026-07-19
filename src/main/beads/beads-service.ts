import {
  hostPathEquals,
  isExecutableLeaf,
  type BeadDependencyEdge,
  type BeadGate,
  type BeadIssue,
  type BeadsChangedEvent,
  type BeadsListRequest,
  type BeadsListResponse,
  type BeadsProbeResponse,
  type BeadsUnavailable,
  type DispatchabilitySource,
  type Disposer,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  classifyListFailure,
  isHostPathShape,
  joinRoot,
  logBeadsFailure,
  parseBeadsListOutput,
  parseDigraphEdges,
  parseDispatchableOutput,
  parseGatesOutput,
  watchKey,
} from './beads-parse'

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
    // Core fetch: without these two the panel has nothing to show, so their
    // failure fails the whole snapshot (existing behaviour, preserved).
    const [base, ready] = await Promise.all([
      this.runList(host, root, []),
      this.runList(host, root, ['--ready']),
    ])
    if (!base.ok) return base.unavailable
    if (!ready.ok) return ready.unavailable
    const readyIds = ready.issues.map((issue) => issue.id)

    // Supplementary enrichments: each is best-effort. A failure degrades that
    // one field (empty edges/gates, structural dispatchability) and is logged —
    // it never blanks the core issue list.
    const [dependencies, gates, dispatch] = await Promise.all([
      this.runDependencyEdges(host, root),
      this.runGates(host, root),
      this.computeDispatchable(host, root, base.issues, base.stdout, readyIds),
    ])

    let closedIssues: readonly BeadIssue[] | undefined
    if (req.includeClosed === true) {
      const closed = await this.runList(host, root, ['--status', 'closed'])
      if (!closed.ok) return closed.unavailable
      closedIssues = closed.issues
    }
    let orchestrationIssues: readonly BeadIssue[] | undefined
    if (req.includeInternals === true) {
      const internals = await this.runList(host, root, [
        '--include-infra',
        '--include-templates',
        '--include-gates',
      ])
      // Debug-only view: if it fails, still return the human snapshot below.
      orchestrationIssues = internals.ok ? internals.issues : []
    }

    return {
      available: true,
      issues: base.issues,
      readyIds,
      dispatchableIds: dispatch.ids,
      dispatchabilitySource: dispatch.source,
      dependencies,
      gates,
      ...(closedIssues ? { closedIssues } : {}),
      ...(orchestrationIssues ? { orchestrationIssues } : {}),
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
    | {
        readonly ok: true
        readonly issues: readonly BeadIssue[]
        readonly stdout: string
      }
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
      return {
        ok: true,
        issues: parseBeadsListOutput(result.stdout),
        stdout: result.stdout,
      }
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

  /**
   * Blocking edges across the whole project, in one call. `bd list --format
   * digraph` emits `<blocker> <blocked>...` lines (dependency graph, execution
   * order: leftmost/source = nothing blocking it). Best-effort: on any failure
   * we log and return no edges rather than failing the snapshot.
   */
  private async runDependencyEdges(
    host: ProjectHost,
    root: HostPath,
  ): Promise<readonly BeadDependencyEdge[]> {
    try {
      const result = await host.exec(
        'bd',
        [
          '-C',
          root.path,
          'list',
          '--format',
          'digraph',
          '--flat',
          '--no-pager',
          '-n',
          '0',
        ],
        { maxBuffer: MAX_OUTPUT_BYTES, loginShell: true },
      )
      if (result.code !== 0) {
        console.error('[beads] dependency edges unavailable', { code: result.code })
        return []
      }
      return parseDigraphEdges(result.stdout)
    } catch (reason) {
      console.error('[beads] dependency edge query failed', reason)
      return []
    }
  }

  /** Open coordination gates (`bd gate list`) — the backbone of "Needs you". */
  private async runGates(
    host: ProjectHost,
    root: HostPath,
  ): Promise<readonly BeadGate[]> {
    try {
      const result = await host.exec(
        'bd',
        ['-C', root.path, 'gate', 'list', '--json', '--no-pager'],
        { maxBuffer: MAX_OUTPUT_BYTES, loginShell: true },
      )
      if (result.code !== 0) return []
      return parseGatesOutput(result.stdout)
    } catch (reason) {
      console.error('[beads] gate query failed', reason)
      return []
    }
  }

  /**
   * Scheduler-dispatchable ids. If a dispatchability predicate is configured —
   * `<root>/.beads/dispatchability.jq` or the `BEADS_DISPATCHABILITY_JQ` path —
   * we run the raw bd JSON through it and trust its output (the scheduler
   * contract is the authority). Otherwise we fall back to a purely structural
   * filter over typed fields: dependency-ready ∩ executable-leaf. Either way the
   * result is computed once, here, never re-derived in the UI.
   */
  private async computeDispatchable(
    host: ProjectHost,
    root: HostPath,
    baseIssues: readonly BeadIssue[],
    baseStdout: string,
    readyIds: readonly string[],
  ): Promise<{
    readonly ids: readonly string[]
    readonly source: DispatchabilitySource
  }> {
    const structural = (): {
      readonly ids: readonly string[]
      readonly source: DispatchabilitySource
    } => {
      const executable = new Set(
        baseIssues
          .filter((issue) => isExecutableLeaf(issue.issueType))
          .map((issue) => issue.id),
      )
      return { ids: readyIds.filter((id) => executable.has(id)), source: 'structural' }
    }

    const predicate = await this.resolveDispatchabilityPredicate(host, root)
    if (predicate === undefined) return structural()
    try {
      const result = await host.exec('jq', ['-cf', predicate], {
        cwd: root,
        loginShell: true,
        input: baseStdout,
        maxBuffer: MAX_OUTPUT_BYTES,
      })
      if (result.code !== 0) {
        console.error(
          '[beads] dispatchability predicate failed; using structural filter',
          {
            predicate,
            code: result.code,
            stderr: result.stderr.trim(),
          },
        )
        return structural()
      }
      return { ids: parseDispatchableOutput(result.stdout), source: 'predicate' }
    } catch (reason) {
      console.error(
        '[beads] dispatchability predicate errored; using structural filter',
        reason,
      )
      return structural()
    }
  }

  /**
   * Locate a dispatchability predicate. The env override wins; otherwise we look
   * at the known conventional locations, in order. Gas City's scheduler
   * dispatchability contract (dr-zkmc) ships as `bin/dispatchability.jq`, so that
   * is checked alongside a project-local `.beads/dispatchability.jq`.
   */
  private async resolveDispatchabilityPredicate(
    host: ProjectHost,
    root: HostPath,
  ): Promise<string | undefined> {
    const override = process.env['BEADS_DISPATCHABILITY_JQ']
    if (override && override !== '') return override
    for (const relative of ['.beads/dispatchability.jq', 'bin/dispatchability.jq']) {
      const candidate = joinRoot(root, relative)
      try {
        const stat = await host.stat(candidate)
        if (stat.type === 'file') return candidate.path
      } catch {
        // Not present; try the next conventional location.
      }
    }
    return undefined
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
