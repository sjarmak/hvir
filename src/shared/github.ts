import type { HostPath } from './host-path'

export type PullState = 'open' | 'merged' | 'closed'

export type PullChecks = 'passing' | 'failing' | 'pending' | 'none'

export type PullReview = 'approved' | 'changes-requested' | 'review-required' | 'none'

export type PullReviewerKind = 'user' | 'team'

export type PullReviewerState = 'approved' | 'changes-requested'

/**
 * One reviewer's standing on a pull request (ADR-976). A user is named by login; a team
 * by its combined `org/slug`. Bots never appear. `pending` means the reviewer is in the
 * current review requests; `requestedAt` is the latest review-requested event naming
 * them; `reviewState` and `reviewedAt` describe their latest opinionated review.
 */
export interface PullReviewer {
  readonly login: string
  readonly kind: PullReviewerKind
  readonly pending: boolean
  readonly requestedAt?: string
  readonly reviewState?: PullReviewerState
  readonly reviewedAt?: string
}

export interface PullSummary {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: PullState
  readonly draft: boolean
  readonly headRef: string
  readonly headRepo?: string
  readonly author: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly checks: PullChecks
  readonly review: PullReview
  readonly openFeedback: number
  readonly headOid?: string
  /** Committed date of the head commit, when GitHub reports one. */
  readonly headCommittedAt?: string
  /** The last ready-for-review event; absent when the pull request was never a draft. */
  readonly readyForReviewAt?: string
  /** The latest assigned event naming the viewer, while the viewer is still assigned. */
  readonly viewerAssignedAt?: string
  /** The viewer's latest review submission on this pull request, if any. */
  readonly viewerReviewedAt?: string
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  /** Reviewers who are pending or hold an opinionated review (ADR-976). */
  readonly reviewers: readonly PullReviewer[]
}

export interface PullReviewComment {
  readonly id: string
  readonly body: string
  readonly author?: string
  readonly createdAt?: string
  readonly commitOid?: string
}

export interface PullReviewThread {
  readonly id: string
  readonly body: string
  readonly author?: string
  readonly path?: string
  readonly line?: number
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly reviewedCommitOid?: string
  readonly comments: readonly PullReviewComment[]
  readonly commentsPageComplete: boolean
}

export interface PullDetail {
  readonly available: true
  readonly repo: string
  readonly number: number
  readonly url: string
  readonly title: string
  readonly headOid?: string
  readonly threads: readonly PullReviewThread[]
  readonly threadsPageComplete: boolean
  readonly payloadTruncated: boolean
}

export type PullDetailResponse = PullDetail | PullsUnavailable

export interface PullDetailRequest {
  readonly root: HostPath
  readonly repo: string
  readonly number: number
  readonly headOid?: string
}

export interface PullsSnapshot {
  readonly available: true
  readonly repo: string
  readonly viewer: string
  readonly branch?: string
  readonly branchPulls: readonly PullSummary[]
  readonly authored: readonly PullSummary[]
  readonly reviewRequested: readonly PullSummary[]
  readonly hasMore: boolean
}

export type PullsUnavailableReason =
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'gh-remote-unauthenticated'
  | 'no-github-repo'
  | 'rate-limited'
  | 'error'

export interface PullsUnavailable {
  readonly available: false
  readonly reason: PullsUnavailableReason
  readonly message: string
}

export type PullsResponse = PullsSnapshot | PullsUnavailable

export interface PullCheckout {
  readonly root: HostPath
  readonly branch?: string
  readonly headRepo?: string
  readonly headRef?: string
}

export type PullCheckoutsResponse =
  | { readonly available: true; readonly checkouts: readonly PullCheckout[] }
  | { readonly available: false; readonly message: string }

export interface PullCheckoutsRequest {
  readonly root: HostPath
}

export interface PullWorktreeRequest {
  readonly root: HostPath
  readonly number: number
}

export const PULLS_PAGE_SIZE = 30
/** Three searches at 100 each time out on GitHub's side for busy repositories (HTTP 502/504). */
export const PULLS_MAX_LIMIT = 60

export interface PullsRequest {
  readonly root: HostPath
  readonly limit?: number
}

export interface PullsProbeRequest {
  readonly root: HostPath
}

export interface PullsProbeResponse {
  readonly hasGitHubRemote: boolean
}
