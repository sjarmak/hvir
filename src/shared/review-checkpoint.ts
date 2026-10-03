import type { HostPath } from './host-path'
import type { TextWorkload } from './viewer-workload-policy'

export type ReviewCheckpointMode = '100644' | '100755' | '120000'

export interface ReviewCheckpointObject {
  readonly mode: ReviewCheckpointMode
  readonly oid: string
}

export interface ReviewCheckpointTreeEntry {
  readonly name: string
  readonly mode: ReviewCheckpointMode | '040000'
  readonly oid: string
}

export interface ReviewCheckpointInspection {
  readonly root: HostPath
  readonly oid: string | null
  readonly objectFormat: 'sha1' | 'sha256'
}

export type ReviewCheckpointHostRequest =
  | { readonly action: 'inspect' | 'files' | 'tracked' }
  | { readonly action: 'tree' | 'blob'; readonly oid: string }
  | { readonly action: 'hash'; readonly relativePath: string; readonly write: boolean }
  | {
      readonly action: 'write-tree'
      readonly entries: readonly ReviewCheckpointTreeEntry[]
    }
  | {
      readonly action: 'update-ref'
      readonly oid: string
      readonly previous: string | null
    }
  | { readonly action: 'clear-ref'; readonly previous: string }
  | {
      readonly action: 'read-live'
      readonly relativePath: string
      readonly expected: ReviewCheckpointObject | null
    }

export type ReviewCheckpointHostResult =
  string | ReviewCheckpointInspection | ReviewCheckpointObject | TextWorkload | null

export interface ReviewCheckpointChange {
  readonly path: HostPath
  readonly before: ReviewCheckpointObject | null
  readonly after: ReviewCheckpointObject | null
}

export interface ReviewCheckpointStatus {
  readonly root: HostPath
  readonly oid: string | null
  readonly changes: readonly ReviewCheckpointChange[]
}

export interface ReviewCheckpointDiff {
  readonly path: HostPath
  readonly checkpoint: string
  readonly baseInput: TextWorkload
  readonly currentInput: TextWorkload
}

export type ReviewCheckpointRequest =
  | { readonly root: HostPath; readonly action: 'status' | 'capture' | 'clear' }
  | {
      readonly root: HostPath
      readonly action: 'diff'
      readonly checkpoint: string
      readonly change: ReviewCheckpointChange
    }

export type ReviewCheckpointResult = ReviewCheckpointStatus | ReviewCheckpointDiff | void
