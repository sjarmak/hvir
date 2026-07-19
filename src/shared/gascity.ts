import type { HostPath } from './host-path'

/**
 * Wire types for the Gas City (`gc`) crew view. The main process shells out to
 * the `gc` CLI on the project host, derives the crew tiering there, and returns
 * these shapes; the renderer never sees raw CLI output and never re-derives
 * which sessions are leads.
 */

/** Crew tiers, ordered as the panel renders them. */
export const GAS_CITY_CREW_TIERS = ['lead', 'worker', 'internal'] as const

/**
 * `lead` — a pinned identity: a configured named session with `mode = "always"`
 * that is not suspended. Rendered even when dormant.
 * `worker` — a session whose backing agent is multi-session (a pool), grouped
 * under {@link GasCityCrewMember.poolName}.
 * `internal` — binding-qualified named sessions and anything else that belongs
 * behind the orchestration-internals toggle.
 */
export type GasCityCrewTier = (typeof GAS_CITY_CREW_TIERS)[number]

/** One live (or suspended) `gc` session, normalized from `gc session list`. */
export interface GasCitySession {
  readonly id: string
  readonly name: string
  readonly alias?: string
  /** Agent template, possibly rig-qualified (`<rig>/agent`). */
  readonly template?: string
  /** Lifecycle state as gc reports it; renderers tolerate unknown values. */
  readonly state: string
  readonly provider?: string
  /** Session working directory, host-qualified against the project host. */
  readonly workDir?: HostPath
  /** Rig name, when gc projects it (Phase 2 enrichment). */
  readonly rig?: string
  /** Namepool the session was drawn from, when gc projects it (Phase 2). */
  readonly pool?: string
  /** Whether gc considers this a configured named session (Phase 2). */
  readonly configuredNamedSession?: boolean
  /** Bead the scheduler currently has attached, when gc projects it (Phase 2). */
  readonly activeBead?: string
  /** Provider context usage percentage, when gc projects it (Phase 2). */
  readonly contextPct?: number
  readonly lastActive?: string
}

/**
 * One crew card. A member with no {@link session} is a configured pinned
 * identity that is not currently running — still rendered, with restart
 * affordances, because its absence is the interesting part.
 */
export interface GasCityCrewMember {
  /** Stable key for React lists and terminal binding; unique within a crew. */
  readonly key: string
  readonly tier: GasCityCrewTier
  /** Display name: the alias for a lead, the session name for a worker. */
  readonly label: string
  /** Argument for `gc session <verb> <target>` — an alias when one exists. */
  readonly target: string
  /**
   * Every name this member answers to (id, session name, alias, template),
   * matching gc's own active-bead matcher so the bead join agrees with the
   * scheduler.
   */
  readonly identityKeys: readonly string[]
  /** Worker-type label for tier 2 grouping (`mem-worker`, `polecat`, …). */
  readonly poolName?: string
  readonly session?: GasCitySession
}

/**
 * How the tiering was derived — surfaced for honesty, and so the panel can say
 * when it is reading a projection rather than gc's own classification.
 */
export type GasCityTierSource = 'session-fields' | 'config'

/**
 * Which crew the workspace is looking at. `city` is the orchestration view —
 * every rig's lead and every active worker. `rig` narrows to this rig plus the
 * city's own leads. Surfaced because a wrong scope is otherwise invisible: it
 * just looks like too many cards.
 */
export type GasCityCrewScope = 'city' | 'rig'

export interface GasCityCrew {
  readonly available: true
  readonly members: readonly GasCityCrewMember[]
  readonly tierSource: GasCityTierSource
  readonly scope: GasCityCrewScope
  /** The rig the workspace resolved to; absent when gc could not name one. */
  readonly rigName?: string
}

export type GasCityUnavailableReason = 'gc-missing' | 'no-city' | 'error'

export interface GasCityUnavailable {
  readonly available: false
  readonly reason: GasCityUnavailableReason
  readonly message: string
}

export type GasCityCrewResponse = GasCityCrew | GasCityUnavailable

export interface GasCityCrewRequest {
  readonly root: HostPath
  /** Also return `internal` tier members (the orchestration-internals toggle). */
  readonly includeInternals?: boolean
}

export interface GasCityProbeRequest {
  readonly root: HostPath
}

/**
 * Cheap "is this workspace inside a Gas City" check — a `.gc` / `city.toml`
 * stat walking up from the workspace root, no `gc` invocation. Drives whether
 * the crew section renders at all, the same way the `.beads` probe gates the
 * Beads tab.
 */
export interface GasCityProbeResponse {
  readonly hasCity: boolean
}
