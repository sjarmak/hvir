import {
  businessAgeTone,
  businessMsBetween,
  formatBusinessAge,
  pullWaitRows,
  type BusinessAgeTone,
  type PullChecks,
  type PullReview,
  type PullSummary,
  type PullWaitList,
  type PullWaitRow,
  type PullsSnapshot,
  type PullsUnavailable,
  type PullsUnavailableReason,
} from '../../../shared'

export type PullSectionKey = 'branch' | PullWaitList

/** A shared wait row without its list; `since` is absent for a branch pull request nobody is waiting on. */
export type PullSectionRow = Omit<PullWaitRow, 'list' | 'since'> & {
  readonly since?: number
}

export interface PullSection {
  readonly key: PullSectionKey
  readonly label: string
  readonly rows: readonly PullSectionRow[]
}

const SECTION_LABELS: Readonly<Record<PullSectionKey, string>> = {
  branch: 'This branch',
  needs: 'Needs you',
  waiting: 'Waiting',
  drafts: 'Drafts',
}

const WAIT_LISTS: readonly PullWaitList[] = ['needs', 'waiting', 'drafts']

const CHECK_LABELS: Readonly<Record<PullChecks, string>> = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI running',
  none: '',
}

const REVIEW_LABELS: Readonly<Record<PullReview, string>> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  none: '',
}

const HINTS: Readonly<Record<PullsUnavailableReason, string>> = {
  'gh-missing': 'Install the GitHub CLI (gh) on this host, then refresh.',
  'gh-unauthenticated': 'Run gh auth login in a terminal, then refresh.',
  'gh-remote-unauthenticated':
    'On this remote host, stored credentials may be unreadable from the SSH session. Run gh auth login --insecure-storage on that host, then refresh.',
  'no-github-repo':
    'gh could not resolve a GitHub repository here. Pick one with gh repo set-default.',
  'rate-limited': 'GitHub rate limit reached. The next refresh tries again.',
  error: 'The GitHub query failed. The next refresh tries again.',
}

function byOpenThenNewest(left: PullSummary, right: PullSummary): number {
  const openRank = Number(right.state === 'open') - Number(left.state === 'open')
  if (openRank !== 0) return openRank
  return right.updatedAt.localeCompare(left.updatedAt)
}

function uniqueByNumber(pulls: readonly PullSummary[]): readonly PullSummary[] {
  const kept = new Map<number, PullSummary>()
  for (const pull of pulls) {
    if (!kept.has(pull.number)) kept.set(pull.number, pull)
  }
  return [...kept.values()]
}

function waitRow({ list: _list, ...row }: PullWaitRow): PullSectionRow {
  return row
}

function branchRow(pull: PullSummary, wait: PullWaitRow | undefined): PullSectionRow {
  return wait === undefined ? { pull, reason: '', waitingOn: [] } : waitRow(wait)
}

/**
 * This branch keeps its membership and recency order; the other sections come from the
 * shared wait derivation (ADR-976), minus the pull requests the branch already shows.
 */
export function pullSections(
  snapshot: PullsSnapshot,
  now: number,
): readonly PullSection[] {
  const waits = pullWaitRows(snapshot, now)
  const branch = [...uniqueByNumber(snapshot.branchPulls)].sort(byOpenThenNewest)
  const shown = new Set(branch.map((pull) => pull.number))
  const section = (
    key: PullSectionKey,
    rows: readonly PullSectionRow[],
  ): PullSection => ({
    key,
    label: SECTION_LABELS[key],
    rows,
  })
  return [
    section(
      'branch',
      branch.map((pull) =>
        branchRow(
          pull,
          waits.find((wait) => wait.pull.number === pull.number),
        ),
      ),
    ),
    ...WAIT_LISTS.map((list) =>
      section(
        list,
        waits
          .filter((wait) => wait.list === list && !shown.has(wait.pull.number))
          .map(waitRow),
      ),
    ),
  ]
}

export function ageLabel(since: number, now: number): string {
  return formatBusinessAge(businessMsBetween(since, now))
}

export function ageTone(since: number, now: number): BusinessAgeTone {
  return businessAgeTone(businessMsBetween(since, now))
}

export function checksLabel(checks: PullChecks): string {
  return CHECK_LABELS[checks]
}

export function reviewLabel(review: PullReview): string {
  return REVIEW_LABELS[review]
}

export function unavailableHint(unavailable: PullsUnavailable): string {
  return HINTS[unavailable.reason]
}
