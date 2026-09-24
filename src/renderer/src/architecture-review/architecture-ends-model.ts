import type { ArchitectureHandoffOrigin } from '../../../shared/architecture-handoff'
import {
  architectureRefProblem,
  type ArchitectureCommitRange,
} from '../../../shared/architecture-review'

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

/**
 * The index one step from `position`. Off the strip, a forward step starts at the oldest
 * commit and a backward step at the newest.
 */
export function stripStep(
  range: ArchitectureCommitRange,
  position: number,
  direction: 1 | -1,
): number | undefined {
  const next =
    position < 0 ? (direction === 1 ? 0 : range.commits.length - 1) : position + direction
  return next >= 0 && next < range.commits.length ? next : undefined
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
