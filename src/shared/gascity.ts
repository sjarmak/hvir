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

/**
 * Activity bands, ordered as the crew lists them: what is running now, then
 * what is parked, then what is not there at all. `other` sits last because an
 * unrecognized state says nothing about whether the session is doing work.
 */
export const GAS_CITY_ACTIVITY_BANDS = ['active', 'idle', 'dormant', 'other'] as const

export type GasCityActivityBand = (typeof GAS_CITY_ACTIVITY_BANDS)[number]

/**
 * Collapse gc's state vocabulary onto the bands the crew orders and styles by.
 * Unknown states fall through to `other` rather than being coerced into one of
 * the known ones. A member with no session is dormant by construction.
 */
export function crewActivityBand(state: string | undefined): GasCityActivityBand {
  if (state === undefined || state === 'not running') return 'dormant'
  if (state === 'active' || state === 'running') return 'active'
  if (state === 'suspended' || state === 'asleep') return 'idle'
  return 'other'
}

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
/**
 * How gc's lifecycle word reads. gc owns the vocabulary and may extend it, so
 * an unrecognized word stays `unknown` instead of being coerced into activity
 * or inactivity — two consumers group on this (the crew panel's styling and the
 * Sessions projection's lifecycle), and they must not disagree about it.
 */
export type GasCitySessionActivity = 'active' | 'idle' | 'unknown'

export function gasCitySessionActivity(state: string | undefined): GasCitySessionActivity {
  if (state === 'active' || state === 'running') return 'active'
  if (state === 'suspended' || state === 'asleep') return 'idle'
  return 'unknown'
}

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
  /**
   * This identity belongs to the city rather than to any rig — the mayor. It
   * sorts above the rig leads, since in the orchestration workspace the city's
   * own lead is the one you are looking for first.
   */
  readonly cityLead?: boolean
  /**
   * The `gc.rig` gas-city's Honeycomb exporter tags this member's spans with:
   * its rig name, or for the city's own leads the basename of the city
   * directory. Absent when the crew could not place the session, so the panel
   * renders no link rather than one that matches nothing.
   */
  readonly traceRig?: string
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

/**
 * What the derivation could *not* account for.
 *
 * The crew is built by matching gc's output against gc's resolved config, and
 * every failure so far has been a rule quietly deciding on data that was not
 * there — a config key read under the wrong name yields zero leads and looks
 * exactly like a city that has none. These counts make that difference visible
 * in the panel instead of leaving it to be reported as a bug.
 */
export interface GasCityCrewDiagnostics {
  /** Named sessions found in the resolved config. */
  readonly namedSessions: number
  /** Of those, how many are pinned identities (`mode = "always"`, not suspended). */
  readonly pinned: number
  /** In-scope sessions matching no named session and no agent — nothing is known about these. */
  readonly unmatched: readonly string[]
}

export interface GasCityCrew {
  readonly available: true
  readonly members: readonly GasCityCrewMember[]
  readonly tierSource: GasCityTierSource
  readonly scope: GasCityCrewScope
  /** The rig the workspace resolved to; absent when gc could not name one. */
  readonly rigName?: string
  /**
   * The city's hq rig; the city bead store is addressed as `city:<hqRigName>`
   * downstream (gas-city handoff_store). Absent when gc could not name it.
   */
  readonly hqRigName?: string
  readonly diagnostics: GasCityCrewDiagnostics
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
  /**
   * Re-read the city's shape (rigs, city root, resolved config) instead of
   * using the cached copy. Set by an explicit refresh, never by the poll — the
   * poll exists to track sessions, and re-composing the whole city every tick is
   * what made the panel slow.
   */
  readonly refresh?: boolean
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
