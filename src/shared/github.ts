import type { HostPath } from './host-path'

export type PullState = 'open' | 'merged' | 'closed'

export type PullChecks = 'passing' | 'failing' | 'pending' | 'none'

export type PullReview = 'approved' | 'changes-requested' | 'review-required' | 'none'

export interface PullSummary {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: PullState
  readonly draft: boolean
  readonly headRef: string
  readonly headRepo?: string
  readonly author: string
  readonly updatedAt: string
  readonly checks: PullChecks
  readonly review: PullReview
  readonly openFeedback: number
  readonly headOid?: string
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

export interface PullsRequest {
  readonly root: HostPath
}

export interface PullsProbeRequest {
  readonly root: HostPath
}

export interface PullsProbeResponse {
  readonly hasGitHubRemote: boolean
}
