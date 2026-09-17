import {
  GAS_CITY_CREW_TIERS,
  gasCitySessionActivity,
  hostPath,
  type GasCityCrewMember,
  type GasCitySession,
  type GasCitySessionActivity,
  type GasCityCrewTier,
  type HostId,
  type HostPath,
} from '../../shared'
import type { GasCityContext } from './gascity-context'
import { deriveCrew } from './gascity-crew'
import { hasProjectedTierFields, rigForPath, type GasCityRig } from './gascity-parse'

/**
 * A whole host's Gas City crew, flattened to the facts a global view needs.
 *
 * The crew panel answers "who is working in *this* workspace"; a global sessions
 * view answers "what is running at all, and where does it belong". Same reads,
 * same derivation, different question — so this module takes the derivation's
 * output and keeps only what survives leaving the workspace: no card affordances,
 * no diagnostics, and no claim about which project owns a session, because that
 * is hvir's to decide and not gc's.
 */

/** One running gc session, host-qualified and stripped to projectable facts. */
export interface CitySessionFact {
  /**
   * gc's own session identifier. Internal to the main process: a consumer mints
   * its own opaque handle for it, and this value never crosses an IPC boundary.
   */
  readonly sessionKey: string
  readonly label: string
  readonly tier: GasCityCrewTier
  readonly poolName?: string
  readonly cityLead?: boolean
  /** Where the session is working, when gc reports it. */
  readonly workDir?: HostPath
  /** Root of the rig the session belongs to; the coarse attribution fallback. */
  readonly rigRoot?: HostPath
  /** Harness gc names, verbatim; the consumer decides whether it knows it. */
  readonly provider?: string
  readonly contextPercent?: number
  readonly bead?: string
  /** gc's lifecycle word, verbatim. */
  readonly state: string
  readonly activity: GasCitySessionActivity
}

/** One host's answer, with the freshness hvir can honestly claim for it. */
export interface HostCitySessions {
  /** The root the reads were made from; its host is the host they describe. */
  readonly root: HostPath
  /** The enclosing city, when a root marker resolved one. */
  readonly cityRoot?: HostPath
  readonly observedAt: number
  /** Age at which the underlying read is no longer authoritative. */
  readonly staleAfterMs: number
  /**
   * The last read failed and these are the sessions from before it. An
   * unavailable source is a state to report, not a reason to show an empty
   * list, so the rows stay and say how old they are.
   */
  readonly stale: boolean
  readonly sessions: readonly CitySessionFact[]
}

export interface DeriveCitySessionsInput {
  /** The root the reads were made from. */
  readonly root: HostPath
  /** The enclosing city, when one resolved; absent leaves lead placement to gc. */
  readonly cityRoot?: HostPath
  readonly sessions: readonly GasCitySession[]
  readonly context: GasCityContext
  /** Orchestration-internal sessions, matching the crew panel's own toggle. */
  readonly includeInternals: boolean
}

/**
 * Per-host cap. A global view bounds its own rows as well; this one keeps a
 * pathological city from being walked and sorted in the first place.
 */
export const MAX_CITY_SESSIONS_PER_HOST = 200

export function deriveCitySessions(
  input: DeriveCitySessionsInput,
): readonly CitySessionFact[] {
  const { context } = input
  const crew = deriveCrew({
    sessions: input.sessions,
    config: context.config,
    rigs: context.rigs,
    rigRoot: input.cityRoot ?? input.root,
    // The whole host at once: this is not a workspace asking about its own crew,
    // so nothing is out of scope on the way in. Which project a session belongs
    // to is decided afterwards, from its working directory.
    cityWorkspace: true,
    includeInternals: input.includeInternals,
    tierSource: hasProjectedTierFields(input.sessions) ? 'session-fields' : 'config',
    ...(context.rigName === undefined ? {} : { rigName: context.rigName }),
    ...(input.cityRoot === undefined ? {} : { cityRoot: input.cityRoot }),
    ...(context.hqRigName === undefined ? {} : { hqRigName: context.hqRigName }),
  })
  return (
    crew.members
      // A member with no session is a configured identity that is not running.
      // It is the interesting part of a crew panel and has no place in a list of
      // sessions: there is no session to project.
      .flatMap((member) =>
        member.session === undefined
          ? []
          : [fact(member, member.session, context, input.root.hostId)],
      )
      .sort(byRunningFirst)
      .slice(0, MAX_CITY_SESSIONS_PER_HOST)
  )
}

function fact(
  member: GasCityCrewMember,
  session: GasCitySession,
  context: GasCityContext,
  hostId: HostId,
): CitySessionFact {
  const rig = rigFor(session, context)
  return {
    sessionKey: session.id,
    label: member.label,
    tier: member.tier,
    state: session.state,
    activity: gasCitySessionActivity(session.state),
    ...(member.poolName === undefined ? {} : { poolName: member.poolName }),
    ...(member.cityLead === undefined ? {} : { cityLead: member.cityLead }),
    ...(session.workDir === undefined ? {} : { workDir: session.workDir }),
    ...(rig === undefined ? {} : { rigRoot: hostPath(hostId, rig.path) }),
    ...(session.provider === undefined ? {} : { provider: session.provider }),
    ...(session.contextPct === undefined ? {} : { contextPercent: session.contextPct }),
    ...(session.activeBead === undefined ? {} : { bead: session.activeBead }),
  }
}

/**
 * The rig a session belongs to: the one gc named, if it is registered, and
 * otherwise the innermost registered rig containing the working directory.
 * Used only as a fallback for placing the session, so a wrong guess here costs
 * a coarse grouping rather than a wrong fact.
 */
function rigFor(
  session: GasCitySession,
  context: GasCityContext,
): GasCityRig | undefined {
  const named =
    session.rig === undefined
      ? undefined
      : context.rigs.find((rig) => rig.name === session.rig)
  if (named !== undefined) return named
  return session.workDir === undefined
    ? undefined
    : rigForPath(context.rigs, session.workDir.path)
}

/**
 * Crew order — tier, then the city's own lead, then pool, then label — with the
 * running sessions ahead of the idle ones inside each pool. A global list is
 * long, and the ones doing something are the ones being looked for.
 */
function byRunningFirst(left: CitySessionFact, right: CitySessionFact): number {
  const tier =
    GAS_CITY_CREW_TIERS.indexOf(left.tier) - GAS_CITY_CREW_TIERS.indexOf(right.tier)
  if (tier !== 0) return tier
  const lead = Number(right.cityLead === true) - Number(left.cityLead === true)
  if (lead !== 0) return lead
  const pool = (left.poolName ?? '').localeCompare(right.poolName ?? '')
  if (pool !== 0) return pool
  const active = Number(right.activity === 'active') - Number(left.activity === 'active')
  if (active !== 0) return active
  return left.label.localeCompare(right.label)
}
