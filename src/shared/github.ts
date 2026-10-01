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
  readonly author: string
  readonly updatedAt: string
  readonly checks: PullChecks
  readonly review: PullReview
  readonly openFeedback: number
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
  'gh-missing' | 'gh-unauthenticated' | 'no-github-repo' | 'rate-limited' | 'error'

export interface PullsUnavailable {
  readonly available: false
  readonly reason: PullsUnavailableReason
  readonly message: string
}

export type PullsResponse = PullsSnapshot | PullsUnavailable

export interface PullsRequest {
  readonly root: HostPath
}

export interface PullsProbeRequest {
  readonly root: HostPath
}

export interface PullsProbeResponse {
  readonly hasGitHubRemote: boolean
}
