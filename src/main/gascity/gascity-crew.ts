import {
  GAS_CITY_CREW_TIERS,
  hostPath,
  hostPathEquals,
  type GasCityCrew,
  type GasCityCrewMember,
  type GasCityCrewTier,
  type GasCitySession,
  type GasCityTierSource,
  type HostPath,
} from '../../shared'
import type { GasCityNamedSessionConfig, GasCityResolvedConfig } from './gascity-config'

/**
 * Crew tiering. Every rule here is structural — a session's working directory,
 * its configured mode, whether its backing agent is multi-session. Nothing keys
 * off a naming convention, so a city that names its leads differently still
 * renders correctly.
 */

export interface DeriveCrewInput {
  readonly sessions: readonly GasCitySession[]
  readonly config: GasCityResolvedConfig
  /** Rig the workspace maps to, when `gc rig list` resolved one. */
  readonly rigName?: string
  /** Workspace root; the rig root for `work_dir` containment. */
  readonly rigRoot: HostPath
  /** The enclosing city's root, when a city marker was found above the workspace. */
  readonly cityRoot?: HostPath
  /** Name of the HQ rig — the city itself — when `gc rig list` resolved one. */
  readonly hqRigName?: string
  /**
   * Whether this workspace *is* the city. The orchestration workspace is the one
   * place you want the whole city at once; a rig workspace is not.
   */
  readonly cityWorkspace: boolean
  readonly includeInternals: boolean
  /** Whether gc already projects the tiering fields (Phase 2 enrichment). */
  readonly tierSource: GasCityTierSource
}

export function deriveCrew(input: DeriveCrewInput): GasCityCrew {
  const live = input.sessions
    .map((session) => crewCandidate(session, input))
    .filter((candidate) => inScope(candidate, input))
    .map(({ member }) => member)
  const dormant = dormantLeads(input, live)
  const members = sortCrew(dedupeByTarget([...live, ...dormant])).filter(
    (member) => input.includeInternals || member.tier !== 'internal',
  )
  return {
    available: true,
    members,
    tierSource: input.tierSource,
    scope: input.cityWorkspace ? 'city' : 'rig',
    ...(input.rigName === undefined ? {} : { rigName: input.rigName }),
  }
}

/**
 * What the workspace is allowed to see.
 *
 * In the **city** workspace — the orchestration project area — the answer is
 * everything: every rig's lead pinned and every active worker, because seeing
 * the whole city at once is the point of standing there.
 *
 * In a **rig** workspace the crew narrows to that rig's lead and workers, plus
 * the city's own lead. Other rigs' leads and workers drop out, and so do the
 * city's worker pools — they are not this workspace's crew, and carrying them
 * makes the section useless exactly where focus matters most.
 */
function inScope(candidate: CrewCandidate, input: DeriveCrewInput): boolean {
  if (input.cityWorkspace) return true
  if (belongsToRig(candidate.session, input)) return true
  return candidate.member.tier === 'lead' && isCityLead(candidate, input)
}

/**
 * Rig association: working directory at or under the rig root, or gc saying so,
 * or a rig-qualified template.
 */
function belongsToRig(
  session: GasCitySession,
  input: Pick<DeriveCrewInput, 'rigRoot' | 'rigName'>,
): boolean {
  const { rigRoot, rigName } = input
  if (session.workDir && isAtOrUnder(session.workDir, rigRoot)) return true
  if (rigName !== undefined) {
    if (session.rig === rigName) return true
    if (session.template?.startsWith(`${rigName}/`) === true) return true
  }
  return false
}

/**
 * The city's *own* lead — the mayor — as opposed to a lead that happens to sit at
 * city scope.
 *
 * A rig's hand-defined lead is a *city-scope* named session — it carries no
 * `rig` key at all, and its rig association lives in `work_dir`, which points at
 * the rig root. So "has no rig" is not enough to mean "is the mayor": read that
 * way, every rig's lead pins itself into every workspace.
 *
 * The rule that actually separates them: with no rig on either side, the city's
 * own lead is the one rooted **at the city**, while a rig's lead is rooted at its
 * rig. An identity with neither a rig nor a working directory has nothing tying
 * it to a rig, so it counts as the city's.
 */
function isCityLead(candidate: CrewCandidate, input: DeriveCrewInput): boolean {
  const rig = candidate.named?.rig ?? candidate.session.rig
  if (rig !== undefined) return rig === input.hqRigName
  const root = identityRoot(candidate, input)
  if (root === undefined) return true
  return input.cityRoot !== undefined && hostPathEquals(root, input.cityRoot)
}

/**
 * Where an identity is rooted. The live session's working directory is the
 * truth when it is running; for a dormant one, the configured `work_dir` on the
 * named session or on its backing agent says where it would run.
 */
function identityRoot(
  candidate: CrewCandidate,
  input: DeriveCrewInput,
): HostPath | undefined {
  return candidate.session.workDir ?? configuredRoot(candidate.named, input)
}

function configuredRoot(
  named: GasCityNamedSessionConfig | undefined,
  input: DeriveCrewInput,
): HostPath | undefined {
  if (named === undefined) return undefined
  const agent =
    named.agent === undefined
      ? undefined
      : input.config.agents.find((candidate) => candidate.name === named.agent)
  const raw = named.workDir ?? agent?.workDir
  return raw === undefined ? undefined : hostPath(input.rigRoot.hostId, raw)
}

function isAtOrUnder(candidate: HostPath, root: HostPath): boolean {
  if (candidate.hostId !== root.hostId) return false
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return candidate.path === root.path || candidate.path.startsWith(prefix)
}

/** A session paired with the crew card and the named-session config behind it. */
interface CrewCandidate {
  readonly session: GasCitySession
  readonly member: GasCityCrewMember
  readonly named: GasCityNamedSessionConfig | undefined
}

function crewCandidate(session: GasCitySession, input: DeriveCrewInput): CrewCandidate {
  const named = matchNamedSession(session, input.config)
  const tier = sessionTier(session, named, input)
  const poolName = tier === 'worker' ? workerPoolName(session, input) : undefined
  const target = session.alias ?? session.name
  return {
    session,
    named,
    member: {
      key: session.id,
      tier,
      label: target,
      target,
      identityKeys: identityKeys(session),
      ...(poolName === undefined ? {} : { poolName }),
      session,
    },
  }
}

function sessionTier(
  session: GasCitySession,
  named: GasCityNamedSessionConfig | undefined,
  input: DeriveCrewInput,
): GasCityCrewTier {
  if (isBindingQualified(session.name) || named?.binding !== undefined) return 'internal'
  if (input.tierSource === 'session-fields') {
    return session.configuredNamedSession === true && session.pool === undefined
      ? 'lead'
      : 'worker'
  }
  return named !== undefined && isPinned(named) ? 'lead' : 'worker'
}

/**
 * A pinned identity: configured with `mode = "always"` and not suspended.
 * Suspended entries drop out, which also dedupes a city that still carries an
 * older suspended generation of the same lead.
 */
function isPinned(named: GasCityNamedSessionConfig): boolean {
  return named.mode === 'always' && !named.suspended && named.binding === undefined
}

function isBindingQualified(name: string): boolean {
  return name.includes('.')
}

/**
 * Worker-type label: gc's projected pool when present, otherwise the configured
 * namepool for the backing agent, otherwise the template — matching how the GC
 * API classifies sessions for its own dashboard.
 */
function workerPoolName(
  session: GasCitySession,
  input: DeriveCrewInput,
): string | undefined {
  if (session.pool !== undefined) return session.pool
  const template = unqualifiedTemplate(session.template)
  if (template === undefined) return undefined
  const agent = input.config.agents.find((candidate) => candidate.name === template)
  return agent?.poolName ?? template
}

function unqualifiedTemplate(template: string | undefined): string | undefined {
  if (template === undefined) return undefined
  const slash = template.lastIndexOf('/')
  return slash >= 0 ? template.slice(slash + 1) : template
}

/**
 * Tie a running session back to the named session that configured it.
 *
 * Name and alias are the reliable link. The agent template is a *fallback*,
 * because gc does not require a named session's runtime name to equal its
 * configured name — a lead configured as `project-lead` can run as `mem-pl`,
 * and matching on name alone silently demotes it to a worker. The fallback is
 * restricted to non-pooled agents so a pool member can never be promoted by
 * sharing a template with a named session.
 */
function matchNamedSession(
  session: GasCitySession,
  config: GasCityResolvedConfig,
): GasCityNamedSessionConfig | undefined {
  const keys = new Set(identityKeys(session))
  const byName = config.namedSessions.find(
    (named) => keys.has(named.name) || (named.alias !== undefined && keys.has(named.alias)),
  )
  if (byName) return byName
  const pooled = new Set(
    config.agents.filter((agent) => agent.pooled).map((agent) => agent.name),
  )
  return config.namedSessions.find(
    (named) =>
      named.agent !== undefined && !pooled.has(named.agent) && keys.has(named.agent),
  )
}

/**
 * Every name a session answers to, matching the identity set gc's own
 * active-bead matcher uses, so the panel's bead join agrees with the scheduler.
 */
function identityKeys(session: GasCitySession): readonly string[] {
  const keys = [session.id, session.name, session.alias, session.template]
  const unqualified = unqualifiedTemplate(session.template)
  if (unqualified !== undefined) keys.push(unqualified)
  return [...new Set(keys.filter((key): key is string => key !== undefined && key !== ''))]
}

/**
 * Pinned identities configured for this workspace that have no live session.
 * They still render, dormant, because "the lead is not running" is exactly the
 * state the crew view exists to surface.
 */
function dormantLeads(
  input: DeriveCrewInput,
  live: readonly GasCityCrewMember[],
): readonly GasCityCrewMember[] {
  const claimed = new Set(live.flatMap((member) => member.identityKeys))
  return input.config.namedSessions
    .filter(isPinned)
    .filter((named) => dormantLeadInScope(named, input))
    .filter((named) => !claimed.has(named.name) && !claimed.has(named.alias ?? named.name))
    .map((named) => {
      const target = named.alias ?? named.name
      return {
        key: `config:${named.name}`,
        tier: 'lead' as const,
        label: target,
        target,
        identityKeys: [
          ...new Set([named.name, named.alias, named.agent].filter((key): key is string => !!key)),
        ],
      }
    })
}

/**
 * A dormant lead renders under the same scope rule as a live one: everything in
 * the city workspace, and in a rig workspace only that rig's lead plus the
 * city's own (a named session with no rig is city-scope by construction).
 */
function dormantLeadInScope(
  named: GasCityNamedSessionConfig,
  input: DeriveCrewInput,
): boolean {
  if (input.cityWorkspace) return true
  if (named.rig !== undefined) {
    return named.rig === input.rigName || named.rig === input.hqRigName
  }
  // Same rule as a live identity: rooted under this rig, or rooted at the city.
  const root = configuredRoot(named, input)
  if (root === undefined) return true
  if (isAtOrUnder(root, input.rigRoot)) return true
  return input.cityRoot !== undefined && hostPathEquals(root, input.cityRoot)
}

/**
 * One card per identity. A city mid-migration can define the same lead twice
 * (a suspended pack entry plus its hand-defined replacement); prefer the entry
 * backed by a live session so the panel never shows a phantom duplicate.
 */
function dedupeByTarget(
  members: readonly GasCityCrewMember[],
): readonly GasCityCrewMember[] {
  const byTarget = new Map<string, GasCityCrewMember>()
  for (const member of members) {
    const existing = byTarget.get(member.target)
    if (existing === undefined || (existing.session === undefined && member.session)) {
      byTarget.set(member.target, member)
    }
  }
  return [...byTarget.values()]
}

function sortCrew(members: readonly GasCityCrewMember[]): readonly GasCityCrewMember[] {
  return [...members].sort((left, right) => {
    const byTier =
      GAS_CITY_CREW_TIERS.indexOf(left.tier) - GAS_CITY_CREW_TIERS.indexOf(right.tier)
    if (byTier !== 0) return byTier
    const byPool = (left.poolName ?? '').localeCompare(right.poolName ?? '')
    if (byPool !== 0) return byPool
    return left.label.localeCompare(right.label)
  })
}
