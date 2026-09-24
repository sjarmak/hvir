import type { HostPath } from './host-path'
import type { ArchitectureReviewSnapshot } from './architecture-review'

/** A path inside the scope a refused scan measured, offered as a narrower scope. */
export interface ArchitectureScopeCandidate {
  readonly path: string
  readonly files: number
  /** Known when the end was listed from Git objects; the live listing carries no sizes. */
  readonly bytes: number | null
}

/**
 * Why a scan was refused instead of read: the end it measured was above the size cap. The
 * review never reads part of a scope, so the person narrows it and scans again (ADR-063).
 */
export interface ArchitectureScopeRefusal {
  readonly message: string
  /** The end whose files were counted, as the snapshot would label it. */
  readonly end: string
  /** The scope that was measured; empty means the whole repository. */
  readonly scope: readonly string[]
  readonly files: number
  /** Null when the file count alone refused the scan before any size was known. */
  readonly bytes: number | null
  readonly maxFiles: number
  readonly maxBytes: number
  /** The largest paths one level inside the measured scope, largest first. */
  readonly candidates: readonly ArchitectureScopeCandidate[]
}

export interface ArchitectureScanRefused {
  readonly refused: ArchitectureScopeRefusal
}
export type ArchitectureScanOutcome = ArchitectureReviewSnapshot | ArchitectureScanRefused

export function isArchitectureScanRefused(
  result: ArchitectureScanOutcome,
): result is ArchitectureScanRefused {
  return 'refused' in result
}

/** Records the scope in the working tree's layout file; an empty scope is the whole repository. */
export interface ArchitectureScopeRequest {
  readonly root: HostPath
  readonly scope: readonly string[]
}
export interface ArchitectureScopeRecord {
  readonly scope: readonly string[]
  /** False when nothing needed recording: no layout file and the whole repository chosen. */
  readonly written: boolean
}
