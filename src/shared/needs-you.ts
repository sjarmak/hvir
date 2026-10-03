import type { BeadsListResponse } from './beads'
import type { HostPath } from './host-path'
import type { PullsResponse } from './github'

export const NEEDS_YOU_PROJECTION_VERSION = 1

export interface NeedsYouDemandRequest {
  readonly demandGeneration: number
}

export interface NeedsYouSource {
  readonly projectId: string
  readonly workspaceId: string
  readonly projectName: string
  readonly workspaceName: string
  readonly root: HostPath
  readonly hostId: string
}

export interface NeedsYouSourceRead<T> {
  readonly response: T
  readonly observedAt: number
  readonly itemLimit?: number
  readonly truncated?: boolean
}

export interface NeedsYouSourceSnapshot extends NeedsYouSource {
  readonly beads: NeedsYouSourceRead<BeadsListResponse>
  readonly pulls: NeedsYouSourceRead<PullsResponse>
}

export interface NeedsYouSnapshot {
  readonly version: typeof NEEDS_YOU_PROJECTION_VERSION
  readonly demandGeneration: number
  readonly revision: number
  readonly observedAt: number
  readonly sources: readonly NeedsYouSourceSnapshot[]
  readonly candidateLimit?: number
  readonly omittedSourceCount?: number
}

export interface NeedsYouChangedEvent {
  readonly candidateRevision: number
}
