import type { ArchitectureHandoffOrigin } from '../../../shared/architecture-handoff'
import {
  architectureRefProblem,
  type ArchitectureCommitRange,
} from '../../../shared/architecture-review'
import type { GitCommitSummary } from '../../../shared/git-types'

/** Snapshot ends as the scan request takes them; an omitted end is the default. */
export interface ArchitectureEnds {
  readonly baseline?: string
  readonly current?: string
}

/** Pairwise compares each commit with its first parent; locked holds one Baseline. */
export type StripStepping =
  { readonly kind: 'pairwise' } | { readonly kind: 'locked'; readonly baseline: string }

/** The ends for the commit at `index`, or undefined when no Baseline exists for it. */
export function stripEnds(
  range: ArchitectureCommitRange,
  index: number,
  stepping: StripStepping,
): ArchitectureEnds | undefined {
  const commit = range.commits[index]
  if (!commit) return undefined
  const baseline = stepping.kind === 'locked' ? stepping.baseline : commit.parent
  return baseline === null ? undefined : { baseline, current: commit.revision }
}

/** The Baseline a lock holds: the chosen one, or the strip base for the branch point. */
export function lockedBaseline(
  ends: ArchitectureEnds,
  range: ArchitectureCommitRange,
): string {
  return ends.baseline ?? range.base.revision
}

/** Index of the strip commit Current names, or -1 when Current is off the strip. */
export function stripPosition(range: ArchitectureCommitRange, revision: string): number {
  return range.commits.findIndex((commit) => commit.revision === revision)
}

export function stripStep(
  range: ArchitectureCommitRange,
  position: number,
  direction: 1 | -1,
  shown: (index: number) => boolean = () => true,
): number | undefined {
  const newest = 0
  const oldest = range.commits.length - 1
  let next = position < 0 ? (direction === 1 ? oldest : newest) : position - direction
  while (next >= 0 && next < range.commits.length) {
    if (shown(next)) return next
    next -= direction
  }
  return undefined
}

export interface ParsedEnds {
  readonly ends: ArchitectureEnds
  readonly problems: { readonly baseline?: string; readonly current?: string }
}

/** Reads the typed ends; a blank field means the default end. */
export function endsFromText(baseline: string, current: string): ParsedEnds {
  const read = (text: string) => {
    const ref = text.trim()
    return ref === '' ? {} : { ref, problem: architectureRefProblem(ref) }
  }
  const b = read(baseline)
  const c = read(current)
  return {
    ends: {
      ...(b.ref === undefined ? {} : { baseline: b.ref }),
      ...(c.ref === undefined ? {} : { current: c.ref }),
    },
    problems: {
      ...(b.problem === undefined ? {} : { baseline: b.problem }),
      ...(c.problem === undefined ? {} : { current: c.problem }),
    },
  }
}

/**
 * Re-snapshot ends for a handed-off worktree: its live tree against the original Current
 * commit shows only the agent's change; against the original Baseline, the cumulative one.
 */
export function handoffEnds(
  origin: ArchitectureHandoffOrigin,
  compare: 'change' | 'cumulative',
): ArchitectureEnds {
  return {
    baseline: compare === 'change' ? origin.currentRevision : origin.baselineRevision,
  }
}

export interface ArchitectureCommitDescription {
  readonly subject: string
  readonly authoredAt: string
}
export type ArchitectureCommitDescriptions = Readonly<
  Record<string, ArchitectureCommitDescription>
>

export function describeShownCommit(
  commit: GitCommitSummary,
  loaded: readonly GitCommitSummary[],
): ArchitectureCommitDescriptions {
  const parent = loaded.find((candidate) => candidate.hash === commit.parents[0])
  return Object.fromEntries(
    [commit, ...(parent ? [parent] : [])].map((each) => [
      each.hash,
      { subject: each.subject, authoredAt: each.authoredAt },
    ]),
  )
}

export function describeCommits(
  range: ArchitectureCommitRange,
  ends: ArchitectureEnds,
): ArchitectureCommitDescriptions {
  const named = [ends.baseline, ends.current].filter((end) => end !== undefined)
  return Object.fromEntries(
    [range.base, ...range.commits]
      .filter((commit) => named.includes(commit.revision))
      .map((commit) => [
        commit.revision,
        { subject: commit.subject, authoredAt: commit.authoredAt },
      ]),
  )
}

export interface HistoryCommitRange {
  readonly olderCommit: GitCommitSummary
  readonly newerCommit: GitCommitSummary
  readonly hashes: readonly string[]
}

export function historyRange(
  anchor: string,
  target: string,
  shown: readonly GitCommitSummary[],
): HistoryCommitRange | undefined {
  const a = shown.findIndex((commit) => commit.hash === anchor)
  const t = shown.findIndex((commit) => commit.hash === target)
  if (a < 0 || t < 0 || a === t) return undefined
  const newest = Math.min(a, t)
  const oldest = Math.max(a, t)
  const members = shown.slice(newest, oldest + 1)
  return {
    olderCommit: members[members.length - 1]!,
    newerCommit: members[0]!,
    hashes: members.map((commit) => commit.hash),
  }
}

export interface HistoryRangeEnds {
  readonly baseline: string
  readonly current: string
}

export function historyRangeEnds(
  range: HistoryCommitRange,
): HistoryRangeEnds | undefined {
  const baseline = range.olderCommit.parents[0]
  return baseline === undefined
    ? undefined
    : { baseline, current: range.newerCommit.hash }
}

export function describeHistoryRange(
  range: HistoryCommitRange,
  loaded: readonly GitCommitSummary[],
): ArchitectureCommitDescriptions {
  return {
    ...describeShownCommit(range.olderCommit, loaded),
    ...describeShownCommit(range.newerCommit, loaded),
  }
}
