import type {
  PullChecks,
  PullReview,
  PullSummary,
  PullsSnapshot,
  PullsUnavailable,
  PullsUnavailableReason,
} from '../../../shared'

export type PullSectionKey = 'branch' | 'review' | 'authored'

export interface PullSection {
  readonly key: PullSectionKey
  readonly label: string
  readonly pulls: readonly PullSummary[]
}

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

function unseen(
  pulls: readonly PullSummary[],
  seen: ReadonlySet<number>,
): readonly PullSummary[] {
  const kept = new Map<number, PullSummary>()
  for (const pull of pulls) {
    if (!seen.has(pull.number) && !kept.has(pull.number)) kept.set(pull.number, pull)
  }
  return [...kept.values()].sort(byOpenThenNewest)
}

export function pullSections(snapshot: PullsSnapshot): readonly PullSection[] {
  const branch = unseen(snapshot.branchPulls, new Set())
  const afterBranch = new Set(branch.map((pull) => pull.number))
  const review = unseen(snapshot.reviewRequested, afterBranch)
  const afterReview = new Set([...afterBranch, ...review.map((pull) => pull.number)])
  const authored = unseen(snapshot.authored, afterReview)
  return [
    { key: 'branch', label: 'This branch', pulls: branch },
    { key: 'review', label: 'Needs your review', pulls: review },
    { key: 'authored', label: 'Yours', pulls: authored },
  ]
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
