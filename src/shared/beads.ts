import type { HostPath } from './host-path'

/**
 * Wire types for the beads (bd) issue viewer. The main process shells out to
 * the `bd` CLI on the project host and returns these shapes; the renderer only
 * ever sees parsed data, never raw CLI output.
 */

/** Stored statuses bd reports today. Unknown values group under "open". */
export const KNOWN_BEAD_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'closed',
] as const

export type KnownBeadStatus = (typeof KNOWN_BEAD_STATUSES)[number]

export interface BeadIssue {
  readonly id: string
  readonly title: string
  /** Stored status string; renderers must tolerate values outside {@link KNOWN_BEAD_STATUSES}. */
  readonly status: string
  /** 0 (highest) through 4; bd may introduce other numbers. */
  readonly priority: number
  readonly issueType: string
  readonly assignee?: string
  readonly labels: readonly string[]
  readonly description?: string
  readonly design?: string
  readonly acceptanceCriteria?: string
  readonly notes?: string
  readonly parent?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly closedAt?: string
  readonly closeReason?: string
  readonly dependencyCount: number
  readonly dependentCount: number
}

export type BeadsUnavailableReason =
  | 'no-database'
  | 'bd-missing'
  /** bd reached a database backend that is configured but not reachable — most
   * often a shared Dolt server whose port bd could not resolve (a missing or
   * invalid `.beads/dolt-server.port`, surfaced by bd as `127.0.0.1:0`). */
  | 'server-unreachable'
  | 'error'

export interface BeadsListRequest {
  readonly root: HostPath
  /** Also fetch closed issues (a separate, lazily requested bd call). */
  readonly includeClosed?: boolean
}

export interface BeadsSnapshot {
  readonly available: true
  /** Every non-closed issue, unsorted; grouping happens in the renderer. */
  readonly issues: readonly BeadIssue[]
  /** Ids bd reports as ready to work (open with no active blockers). */
  readonly readyIds: readonly string[]
  /** Present only when {@link BeadsListRequest.includeClosed} was set. */
  readonly closedIssues?: readonly BeadIssue[]
}

export interface BeadsUnavailable {
  readonly available: false
  readonly reason: BeadsUnavailableReason
  readonly message: string
}

export type BeadsListResponse = BeadsSnapshot | BeadsUnavailable

export interface BeadsWatchRequest {
  readonly root: HostPath
}

export interface BeadsProbeRequest {
  readonly root: HostPath
}

/**
 * Cheap "does this workspace have a beads project" check — a `.beads` directory
 * stat, no `bd` and no server. Drives whether the Beads rail tab is shown, the
 * same way `.git` discovery drives the Git tab.
 */
export interface BeadsProbeResponse {
  readonly hasProject: boolean
}

export interface BeadsChangedEvent {
  readonly root: HostPath
}
