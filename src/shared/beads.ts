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
  /** Future defer timestamp when bd reports one; drives "planned, not yet executable". */
  readonly deferUntil?: string
  /** Flat string metadata bd carries (routing, spec ids, etc.); absent keys are ignored. */
  readonly metadata?: Readonly<Record<string, string>>
  readonly dependencyCount: number
  readonly dependentCount: number
}

/**
 * One blocking edge in the dependency graph: `blockerId` must close before
 * `blockedId` can proceed. The renderer resolves ids to titles and inverts the
 * set to compute how many items each bead "unlocks". Sourced once, in the main
 * process, so no UI component re-derives dependency structure.
 */
export interface BeadDependencyEdge {
  readonly blockerId: string
  readonly blockedId: string
}

/**
 * An async coordination gate (`bd gate`). Human gates are the backbone of the
 * "Needs you" section: something a person must close before blocked work resumes.
 */
export interface BeadGate {
  readonly id: string
  readonly title: string
  /** bd gate type: human | timer | gh:run | gh:pr | bead. */
  readonly gateType: string
  /** The issue this gate is blocking, when bd reports it. */
  readonly blockedId?: string
  /** Gate lifecycle state as bd reports it (e.g. open, closed). */
  readonly state: string
}

/** How {@link BeadsSnapshot.dispatchableIds} was derived — surfaced for honesty. */
export type DispatchabilitySource = 'predicate' | 'structural'

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
  /** Also fetch orchestration/infra/template beads for the debug view (lazy). */
  readonly includeInternals?: boolean
}

export interface BeadsSnapshot {
  readonly available: true
  /** Every non-closed issue, unsorted; grouping happens in the renderer. */
  readonly issues: readonly BeadIssue[]
  /**
   * Ids bd reports as dependency-ready (open, no active blockers). This is
   * canonical `bd ready` — NOT the same as executable/dispatchable. Kept
   * separately named from {@link dispatchableIds} on purpose (hard guardrail).
   */
  readonly readyIds: readonly string[]
  /**
   * Ids that are actually next to run: scheduler-dispatchable work. Derived in
   * the main process either from a configured dispatchability predicate or, when
   * none is present, a structural filter over typed fields — see
   * {@link dispatchabilitySource}. The renderer's "Ready next" uses this, never
   * {@link readyIds}.
   */
  readonly dispatchableIds: readonly string[]
  /** Whether {@link dispatchableIds} came from a real predicate or a structural approximation. */
  readonly dispatchabilitySource: DispatchabilitySource
  /** Blocking edges across the fetched set; empty if the edge query was unavailable. */
  readonly dependencies: readonly BeadDependencyEdge[]
  /** Open coordination gates; empty if the gate query was unavailable. */
  readonly gates: readonly BeadGate[]
  /** Present only when {@link BeadsListRequest.includeClosed} was set. */
  readonly closedIssues?: readonly BeadIssue[]
  /** Orchestration/infra/template beads; present only when {@link BeadsListRequest.includeInternals} was set. */
  readonly orchestrationIssues?: readonly BeadIssue[]
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
