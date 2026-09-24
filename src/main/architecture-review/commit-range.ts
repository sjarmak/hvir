import {
  ARCHITECTURE_COMMIT_STRIP_LIMIT,
  architectureRefProblem,
  type ArchitectureCommit,
  type ArchitectureCommitRange,
  type ArchitectureCommitRangeRequest,
} from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import { branchPoint, commitOf, type EndsGit } from './ends'
import { architectureGitContext, validateArchitectureRoot } from './git-context'

/** Hash, parents and subject; -z ends each commit with NUL, which no subject contains. */
const FORMAT = '--format=%H%x1f%P%x1f%s'
const MAX_OUTPUT = 1024 * 1024

/**
 * The commit strip (ADR-063): first-parent commits from the branch point with the default
 * branch, or with `from` when widened, to HEAD. The newest `limit` are kept.
 */
export async function listArchitectureCommits(
  host: ProjectHost,
  request: ArchitectureCommitRangeRequest,
  signal: AbortSignal,
  limit = ARCHITECTURE_COMMIT_STRIP_LIMIT,
): Promise<ArchitectureCommitRange> {
  validateArchitectureRoot(host, request.root)
  const problem =
    request.from === undefined ? undefined : architectureRefProblem(request.from)
  if (problem) throw new Error(`Invalid strip ref: ${problem}`)
  const context = architectureGitContext(host, request.root, signal)
  const run = (args: readonly string[]) => context.run(request.root, args, MAX_OUTPUT)
  const git: EndsGit = {
    tryRun: (args) => context.tryRun(request.root, args),
    defaultBranch: () => context.defaultBranch(request.root),
  }
  const base =
    request.from === undefined
      ? await branchPoint(git, 'HEAD')
      : await mergeBase(git, await commitOf(git, 'Strip', request.from))
  const [baseCommit] = parseCommits(await run(['log', '-1', '-z', FORMAT, base, '--']))
  if (!baseCommit) throw new Error('Git did not describe the strip base')
  const newest = parseCommits(
    await run([
      'log',
      '-z',
      '--first-parent',
      `--max-count=${limit + 1}`,
      FORMAT,
      `${base}..HEAD`,
      '--',
    ]),
  )
  return {
    base: baseCommit,
    commits: newest.slice(0, limit).reverse(),
    truncated: newest.length > limit,
  }
}

async function mergeBase(git: EndsGit, commit: string): Promise<string> {
  const output = await git.tryRun(['merge-base', commit, 'HEAD'])
  const hash = output?.trim() ?? ''
  if (!/^[a-f0-9]{40,64}$/.test(hash))
    throw new Error('The strip ref shares no history with HEAD')
  return hash
}

function parseCommits(output: string): readonly ArchitectureCommit[] {
  return output
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [revision = '', parents = '', ...subject] = record.split('\x1f')
      if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Malformed Git log entry')
      return {
        revision,
        parent: parents.split(' ').find(Boolean) ?? null,
        subject: subject.join('\x1f'),
      }
    })
}
