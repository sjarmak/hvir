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
  const scoped = input.sessions
    .map((session) => crewCandidate(session, input))
    .filter((candidate) => inScope(candidate, input))
  const live = scoped.map(({ member }) => member)
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
    diagnostics: {
      namedSessions: input.config.namedSessions.length,
      pinned: input.config.namedSessions.filter(isPinned).length,
      unmatched: scoped
        .filter((candidate) => !candidate.classified)
        .map((candidate) => candidate.member.label),
    },
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
  if (belongsToRig(candidate, input)) return true
  return candidate.member.tier === 'lead' && isCityLead(candidate, input)
}

/**
 * Rig association, strongest signal first.
 *
 * gc qualifies a session's name and template with the **rig root path**
 * (`/home/ds/projects/mem/mem-worker`), which is the one signal that survives
 * worktrees: a worker's `work_dir` is often a worktree
 * (`/home/ds/gascity-worktrees/polecat-3`) that lives nowhere near the rig it
 * belongs to, so containment alone loses it.
 */
function belongsToRig(candidate: CrewCandidate, input: DeriveCrewInput): boolean {
  const { session, named } = candidate
  const { rigRoot, rigName } = input
  if (rigName !== undefined && (session.rig === rigName || named?.rig === rigName)) {
    return true
  }
  const qualified = qualifiedRoot(session, rigRoot.hostId)
  if (qualified) {
    // An absolute qualifier names the rig outright, so it settles the question
    // either way — a worktree `work_dir` under some unrelated root must not then
    // claim the session for a different rig.
    return hostPathEquals(qualified, rigRoot)
  }
  if (rigName !== undefined && session.template?.startsWith(`${rigName}/`) === true) {
    return true
  }
  return session.workDir !== undefined && isAtOrUnder(session.workDir, rigRoot)
}

/**
 * The rig root gc qualified this session with:
 * `/home/ds/projects/mem/mem-worker` yields `/home/ds/projects/mem`.
 *
 * Only an **absolute** prefix is a rig root. A relative qualifier (`mem/agent`)
 * names a rig, not a directory, and is matched against the rig name instead; a
 * bare identity (`mayor`) has neither.
 */
function qualifiedRoot(
  session: GasCitySession,
  hostId: HostPath['hostId'],
): HostPath | undefined {
  const source = session.template ?? session.name
  if (!source.startsWith('/')) return undefined
  const slash = source.lastIndexOf('/')
  return slash > 0 ? hostPath(hostId, source.slice(0, slash)) : undefined
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
  // With no city root resolved there is nothing to compare against. Be
  // permissive rather than silently dropping the mayor: an extra lead is a
  // visible annoyance, a missing one looks like the crew view is just wrong.
  if (input.cityRoot === undefined) return true
  const root = identityRoot(candidate, input)
  return root === undefined || hostPathEquals(root, input.cityRoot)
}

/**
 * Where an identity is rooted. The rig-qualified name wins over `work_dir`,
 * which for a pooled worker is usually a worktree rather than the rig itself.
 * For a dormant identity the configured `work_dir` says where it would run.
 */
function identityRoot(
  candidate: CrewCandidate,
  input: DeriveCrewInput,
): HostPath | undefined {
  return (
    qualifiedRoot(candidate.session, input.rigRoot.hostId) ??
    candidate.session.workDir ??
    configuredRoot(candidate.named, input)
  )
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
  /** Whether any config entry — named session or agent — described this session. */
  readonly classified: boolean
}

function crewCandidate(session: GasCitySession, input: DeriveCrewInput): CrewCandidate {
  const named = matchNamedSession(session, input.config)
  const tier = sessionTier(session, named, input)
  const poolName = tier === 'worker' ? workerPoolName(session, input) : undefined
  const template = unqualifiedTemplate(session.template)
  return {
    session,
    named,
    classified:
      named !== undefined ||
      (template !== undefined &&
        input.config.agents.some((agent) => agent.name === template)),
    member: {
      key: session.id,
      tier,
      label: displayLabel(session),
      target: commandTarget(session),
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
  // The same agent name recurs once per rig, so prefer the entry scoped to this
  // session's rig before falling back to any entry with that name.
  const rig = candidateRig(session, input)
  const byName = input.config.agents.filter((agent) => agent.name === template)
  const agent = byName.find((candidate) => candidate.rig === rig) ?? byName[0]
  return agent?.poolName ?? template
}

/** The rig a session's qualified name points at, as a rig *name* when known. */
function candidateRig(
  session: GasCitySession,
  input: DeriveCrewInput,
): string | undefined {
  if (session.rig !== undefined) return session.rig
  const qualified = qualifiedRoot(session, input.rigRoot.hostId)
  return qualified !== undefined && hostPathEquals(qualified, input.rigRoot)
    ? input.rigName
    : undefined
}

/**
 * gc names sessions with their rig path baked in
 * (`/home/ds/projects/mem/mem-worker-2`). The path is how the crew resolves a
 * rig, but it is not what anyone wants to read on a card.
 */
function displayLabel(session: GasCitySession): string {
  return basename(session.alias ?? session.name)
}

/**
 * What `gc session <verb> <target>` gets. The session id is unambiguous and
 * documented; the alias is preferred only when it is a plain identifier, since
 * a path-shaped alias is fragile on a command line and unreadable in a title.
 */
function commandTarget(session: GasCitySession): string {
  const alias = session.alias ?? session.name
  return alias.includes('/') ? session.id : alias
}

function basename(value: string): string {
  const slash = value.lastIndexOf('/')
  return slash >= 0 ? value.slice(slash + 1) : value
}

function unqualifiedTemplate(template: string | undefined): string | undefined {
  return template === undefined ? undefined : basename(template)
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
  const qualified = [session.id, session.name, session.alias, session.template]
  // Both forms count: a bead can be assigned by the full rig-qualified name or
  // by the bare one, and gc's matcher accepts either.
  const keys = qualified.flatMap((key) =>
    key === undefined ? [] : [key, basename(key)],
  )
  return [...new Set(keys.filter((key) => key !== ''))]
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
  if (root === undefined || input.cityRoot === undefined) return true
  return isAtOrUnder(root, input.rigRoot) || hostPathEquals(root, input.cityRoot)
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
