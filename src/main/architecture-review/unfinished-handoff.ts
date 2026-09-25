import { ARCHITECTURE_BRIEF_FILE } from '../../shared/architecture-handoff'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  HVIR_ARCHITECTURE_BRANCH_PREFIX,
  hvirBranchRef,
  hvirWorktreeTarget,
  hvirWorktreeSlug,
  isHvirCommit,
  isHvirWorktreePath,
  type HvirWorktreeTarget,
} from '../git/hvir-worktrees'

/**
 * An unfinished handoff (ADR-063): a worktree an architecture-review handoff created whose
 * brief never landed, so no agent was launched there, and where nothing has happened
 * since. Every fact is read from disk and Git, never from the review that created it, so
 * the verdict survives a closed review, a rescan or an application restart:
 *
 * 1. its branch is `hvir/architecture/<slug>` and it sits at `<root>.hvir-worktrees/<slug>`,
 *    the one place a handoff creates it, which resolves to itself and not the main tree;
 * 2. no hvir terminal session is recorded or running in it, and main is not carrying out
 *    a handoff there right now (`HandoffsInFlight`);
 * 3. the snapshot brief is absent;
 * 4. the branch reflog holds exactly its creation entry, at the worktree's HEAD: nothing
 *    was committed, reset or amended since the handoff created it;
 * 5. `git status` reports nothing, ignored files included, and no index entry carries the
 *    assume-unchanged or skip-worktree bit that would hide a tracked edit from that status,
 *    so removal loses nothing.
 */
export interface HandoffWorktreeFacts {
  readonly root: HostPath
  readonly branch?: string
  readonly head?: string
}

/** What main itself is doing in the worktree, which disk and Git cannot show. */
export interface HandoffWorktreeActivity {
  readonly terminalIds: readonly string[]
  /** A handoff holds it between creating the worktree and settling its brief write. */
  readonly inFlight: boolean
}

export type UnfinishedHandoffVerdict =
  | { readonly unfinished: true; readonly target: HvirWorktreeTarget }
  | { readonly unfinished: false; readonly reason: string }

const TIMEOUT = 30_000
const CREATED = 'branch: Created from '

export async function inspectUnfinishedHandoff(
  host: ProjectHost,
  registeredRoot: HostPath,
  worktree: HandoffWorktreeFacts,
  activity: HandoffWorktreeActivity,
): Promise<UnfinishedHandoffVerdict> {
  if (activity.inFlight) return refuse('its handoff is still in flight')
  const slug = hvirWorktreeSlug(worktree.branch)
  if (slug === undefined || !worktree.branch)
    return refuse(`its branch is not under ${HVIR_ARCHITECTURE_BRANCH_PREFIX}`)
  if (!isHvirCommit(worktree.head)) return refuse('its HEAD is not a commit')
  if (
    worktree.root.hostId !== registeredRoot.hostId ||
    !isHvirWorktreePath(registeredRoot.path, worktree.root.path)
  )
    return refuse('it is not at the location an architecture handoff creates')
  const target = hvirWorktreeTarget(registeredRoot, slug, worktree.head)
  if (target.path !== worktree.root.path)
    return refuse('its directory does not match its branch')
  const [resolved, main] = await Promise.all([
    host.realpath(worktree.root),
    host.realpath(registeredRoot),
  ])
  if (resolved.path !== target.path || resolved.path === main.path)
    return refuse('its path resolves somewhere else')
  if (activity.terminalIds.length > 0)
    return refuse('an hvir terminal session belongs to it')
  if (await exists(host, joinHostPath(worktree.root, ARCHITECTURE_BRIEF_FILE)))
    return refuse('its snapshot brief was written, so the handoff reached its agent')
  if (!(await onlyCreated(host, worktree.root, worktree.branch, target.commit)))
    return refuse('its branch has commits or history beyond its start point')
  if (!(await clean(host, worktree.root)))
    return refuse('it has changes, untracked or ignored files')
  if (await mayHideEdits(host, worktree.root))
    return refuse(
      'an index entry is marked assume-unchanged or skip-worktree, so edits may be hidden',
    )
  return { unfinished: true, target }
}

function refuse(reason: string): UnfinishedHandoffVerdict {
  return { unfinished: false, reason }
}

async function exists(host: ProjectHost, file: HostPath): Promise<boolean> {
  try {
    await host.stat(file)
    return true
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT' || code === 2) return false
    throw error
  }
}

/** The branch reflog is exactly one creation entry, at `commit`. */
async function onlyCreated(
  host: ProjectHost,
  worktree: HostPath,
  branch: string,
  commit: string,
): Promise<boolean> {
  const ref = hvirBranchRef(branch)
  if (!ref) return false
  const result = await git(host, worktree, [
    'reflog',
    'show',
    '-n2',
    '--format=%H%x1f%gs',
    ref,
    '--',
  ])
  if (result.code !== 0) return false
  const entries = result.stdout.split('\n').filter((line) => line !== '')
  if (entries.length !== 1) return false
  const [hash, subject = ''] = entries[0]!.split('\x1f')
  return hash === commit && subject.startsWith(CREATED)
}

async function clean(host: ProjectHost, worktree: HostPath): Promise<boolean> {
  const result = await git(
    host,
    worktree,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional'],
    { allowTruncatedOutput: true, maxStdoutNulRecords: 1 },
  )
  if (result.outputTruncated) return false
  if (result.code !== 0)
    throw new Error(`Could not read the worktree status: ${result.stderr.trim()}`)
  return result.stdout === ''
}

/**
 * True when any index entry carries the assume-unchanged bit (a lowercase `ls-files -v`
 * tag) or the skip-worktree bit (`S` or `s`), either of which keeps an edit out of
 * `git status`. An index too large to read whole counts as hiding, never as clean.
 */
async function mayHideEdits(host: ProjectHost, worktree: HostPath): Promise<boolean> {
  const result = await git(host, worktree, ['ls-files', '-v', '-z'], {
    allowTruncatedOutput: true,
  })
  if (result.outputTruncated) return true
  if (result.code !== 0)
    throw new Error(`Could not read the worktree index: ${result.stderr.trim()}`)
  return result.stdout
    .split('\0')
    .some((entry) => entry !== '' && hidesEdits(entry[0]!))
}

function hidesEdits(tag: string): boolean {
  return tag === 'S' || tag !== tag.toUpperCase()
}

function git(
  host: ProjectHost,
  worktree: HostPath,
  args: readonly string[],
  options: {
    readonly allowTruncatedOutput?: true
    readonly maxStdoutNulRecords?: number
  } = {},
) {
  return host.exec('git', ['-C', worktree.path, ...args], {
    timeout: TIMEOUT,
    env: { GIT_OPTIONAL_LOCKS: '0' },
    ...options,
  })
}
