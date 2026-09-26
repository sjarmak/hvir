import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  ARCHITECTURE_BRIEF_FILE,
  type ArchitectureAgentLaunch,
  type ArchitectureHandoffOrigin,
} from '../../shared/architecture-handoff'
import { ARCHITECTURE_EXPLANATION_FILE } from '../../shared/architecture-explanation'
import {
  hostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import type { AddedWorktree, HeldWorktree } from '../git/mutation-coordinator'
import type { HvirWorktreeTarget } from '../git/hvir-worktrees'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ArchitectureLiveBase } from './freshness'
import { parseArchitectureBriefOrigin } from './handoff-brief'

/** Worktree creation through the Git mutation path; the review never runs Git writes. */
export interface ArchitectureWorktreePort {
  /** The exact target a handoff from the active `root` would create. */
  worktreeTarget(root: HostPath, slug: string, commit: string): HvirWorktreeTarget
  /** Creates the worktree, held in flight until the handoff releases it (ADR-063). */
  addWorktree(root: HostPath, slug: string, commit: string): Promise<HeldWorktree>
  /** Holds the worktree an interrupted handoff created while a retry finishes it. */
  holdWorktree(added: AddedWorktree): Promise<HeldWorktree>
}

const TIMEOUT = 30_000
const MAX_LAUNCHES = 16
const MAX_MARKER_BYTES = 4 * 1024
const EXCLUDE_ENTRIES = [
  `/${ARCHITECTURE_BRIEF_FILE}`,
  `/${ARCHITECTURE_EXPLANATION_FILE}`,
]

/**
 * The commit the handoff worktree starts at: the Current commit, or for a live Current the
 * HEAD a clean in-scope tree equals. Anything else would hand the agent a different tree.
 */
export function handoffCommit(
  currentRevision: string | undefined,
  base: ArchitectureLiveBase,
): string {
  if (base.prefix !== '')
    throw new Error(
      'Agent handoff needs a review of the whole repository; open the review at the repository root',
    )
  if (currentRevision !== undefined) return currentRevision
  if (!base.clean)
    throw new Error(
      "Commit the in-scope changes before handing off; the agent's worktree starts at a commit",
    )
  return base.head
}

/**
 * Writes the brief untracked at the worktree root after excluding it through the
 * repository's info/exclude, never .gitignore. Every Git call is argv, never a shell.
 */
export async function writeArchitectureBrief(
  host: ProjectHost,
  worktree: HostPath,
  brief: string,
  signal: AbortSignal,
): Promise<void> {
  const exclude = await gitPath(host, worktree, 'info/exclude', signal)
  await appendExclude(host, exclude)
  const file = joinHostPath(worktree, ARCHITECTURE_BRIEF_FILE)
  await host.createFileExclusive(file, { mode: 0o644, signal })
  await host.writeFile(file, brief, { signal })
}

async function gitPath(
  host: ProjectHost,
  worktree: HostPath,
  name: string,
  signal: AbortSignal,
): Promise<HostPath> {
  const result = await host.exec(
    'git',
    ['-C', worktree.path, 'rev-parse', '--git-path', name],
    { signal, timeout: TIMEOUT, env: { GIT_OPTIONAL_LOCKS: '0' } },
  )
  const path = result.stdout.trim()
  if (result.code !== 0 || !path || path.includes('\n'))
    throw new Error(`Could not locate the worktree's ${name}: ${result.stderr.trim()}`)
  return hostPath(
    worktree.hostId,
    path.startsWith('/') ? path : posix.join(worktree.path, path),
  )
}

async function appendExclude(host: ProjectHost, file: HostPath): Promise<void> {
  const existing = await readOptional(host, file)
  if (existing === undefined) await ensureDirectory(host, parentOf(file))
  const text = existing ?? ''
  const lines = new Set(text.split('\n'))
  const additions = EXCLUDE_ENTRIES.filter((entry) => !lines.has(entry))
  if (additions.length === 0) return
  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  await host.writeFile(file, `${text}${separator}${additions.join('\n')}\n`)
}

async function readOptional(
  host: ProjectHost,
  file: HostPath,
): Promise<string | undefined> {
  try {
    return await host.readTextFile(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function ensureDirectory(host: ProjectHost, directory: HostPath): Promise<void> {
  try {
    await host.createDirectoryExclusive(directory, { mode: 0o755 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
}

/**
 * The origin a handed-off worktree's brief records, or null when the workspace has no
 * brief or its marker is not exactly valid. Only the marker line is read.
 */
export async function readArchitectureBriefOrigin(
  host: ProjectHost,
  file: HostPath,
): Promise<ArchitectureHandoffOrigin | null> {
  try {
    const prefix = await host.readTextFilePrefix(file, MAX_MARKER_BYTES)
    return parseArchitectureBriefOrigin(prefix.content)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function parentOf(file: HostPath): HostPath {
  return hostPath(file.hostId, posix.dirname(file.path))
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 2
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined
}

interface IssuedLaunch {
  readonly owner: RendererOwner
  readonly host: ProjectHost
  readonly root: HostPath
  readonly digest: string
  readonly body: string
  readonly launched: boolean
}

/**
 * One launch per created worktree. A launch is spent before the native start, so an
 * uncertain start can never silently open a second agent session in the same worktree.
 */
export class ArchitectureLaunches {
  private readonly launches = new Map<string, IssuedLaunch>()

  issue(
    owner: RendererOwner,
    host: ProjectHost,
    root: HostPath,
    digest: string,
    body: string,
  ): ArchitectureAgentLaunch {
    const handoffId = randomUUID()
    this.launches.set(handoffId, { owner, host, root, digest, body, launched: false })
    while (this.launches.size > MAX_LAUNCHES)
      this.launches.delete(this.launches.keys().next().value!)
    return { handoffId, root, digest }
  }

  consume(
    owner: RendererOwner,
    host: ProjectHost,
    launch: ArchitectureAgentLaunch,
  ): string {
    const issued = this.matching(owner, host, launch)
    if (!issued || issued.launched)
      throw new Error('Architecture review launch is unavailable or already used')
    this.launches.set(launch.handoffId, { ...issued, launched: true })
    return issued.body
  }

  assertCurrent(
    owner: RendererOwner,
    host: ProjectHost,
    launch: ArchitectureAgentLaunch,
  ): void {
    if (!this.matching(owner, host, launch)?.launched)
      throw new Error('Architecture review launch was cancelled')
  }

  clear(): void {
    this.launches.clear()
  }

  private matching(
    owner: RendererOwner,
    host: ProjectHost,
    launch: ArchitectureAgentLaunch,
  ): IssuedLaunch | undefined {
    if (!launch || typeof launch.handoffId !== 'string') return undefined
    const issued = this.launches.get(launch.handoffId)
    return issued &&
      issued.owner.id === owner.id &&
      issued.owner.generation === owner.generation &&
      issued.host === host &&
      issued.digest === launch.digest &&
      !!launch.root &&
      hostPathEquals(issued.root, launch.root)
      ? issued
      : undefined
  }
}
