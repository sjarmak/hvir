import {
  ARCHITECTURE_BRANCH_POINT,
  ARCHITECTURE_WORKING_TREE,
  architectureRefProblem,
  type ArchitectureCaptureRequest,
} from '../../shared/architecture-review'

type Ends = Pick<ArchitectureCaptureRequest, 'baseline' | 'current'>

export interface ResolvedEnds {
  readonly baselineRef: string
  readonly currentRef: string
  readonly baselineRevision: string
  /** The Current commit; undefined when Current is the live working tree. */
  readonly currentCommit?: string
}

/** Git reads for resolving ends; `tryRun` yields undefined when Git exits non-zero. */
export interface EndsGit {
  tryRun(args: readonly string[]): Promise<string | undefined>
  defaultBranch(): Promise<string>
}

/** Only a Current end read from the working tree can change after capture (ADR-063). */
export function hasLiveCurrent(ends: Ends): boolean {
  return ends.current === undefined
}

/** Refuses a malformed or option-shaped ref before any Git command sees it. */
export function validateArchitectureEnds(ends: Ends): void {
  for (const [name, ref] of [
    ['Baseline', ends.baseline],
    ['Current', ends.current],
  ] as const) {
    if (ref === undefined) continue
    const problem = architectureRefProblem(ref)
    if (problem) throw new Error(`Invalid ${name} ref: ${problem}`)
  }
}

/**
 * Resolves each end to an exact commit. An omitted Baseline is the branch point of the
 * Current commit (HEAD when Current is live) with the default branch.
 */
export async function resolveArchitectureEnds(
  ends: Ends,
  git: EndsGit,
): Promise<ResolvedEnds> {
  validateArchitectureEnds(ends)
  const currentCommit =
    ends.current === undefined ? undefined : await commitOf(git, 'Current', ends.current)
  const baselineRevision =
    ends.baseline === undefined
      ? await branchPoint(git, currentCommit ?? 'HEAD')
      : await commitOf(git, 'Baseline', ends.baseline)
  return {
    baselineRef: ends.baseline ?? ARCHITECTURE_BRANCH_POINT,
    currentRef: ends.current ?? ARCHITECTURE_WORKING_TREE,
    baselineRevision,
    ...(currentCommit === undefined ? {} : { currentCommit }),
  }
}

/** `ref` is validated first, so `<ref>^{commit}` can never be read as an option. */
export async function commitOf(git: EndsGit, name: string, ref: string): Promise<string> {
  const problem = architectureRefProblem(ref)
  if (problem) throw new Error(`Invalid ${name} ref: ${problem}`)
  const output = await git.tryRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return commitHash(output, `${name} ref "${ref}" does not name a commit`)
}

export async function branchPoint(git: EndsGit, commit: string): Promise<string> {
  const branch = await git.defaultBranch()
  const output = await git.tryRun(['merge-base', commit, branch])
  return commitHash(output, `No branch point with ${branch}; choose a Baseline ref`)
}

function commitHash(output: string | undefined, failure: string): string {
  const hash = output?.trim() ?? ''
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error(failure)
  return hash
}
