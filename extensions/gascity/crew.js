/* global window, module */
/**
 * Crew tiering, ported from the built-in (src/main/gascity/gascity-crew.ts, with the bead join
 * from src/renderer/src/beads/crew-model.ts). Every rule is structural: a session's working
 * directory and rig-qualified name, its configured mode, whether its backing agent is pooled.
 * Nothing keys off a naming convention. Paths are plain strings: one view reads one host.
 */
;(() => {
  /** Tiers in render order. */
  const TIERS = ['lead', 'worker', 'internal']
  /** Activity bands in crew order: running, parked, absent, unrecognized. */
  const BANDS = ['active', 'idle', 'dormant', 'other']

  function activityBand(state) {
    if (state === undefined || state === 'not running') return 'dormant'
    if (state === 'active' || state === 'running') return 'active'
    if (state === 'suspended' || state === 'asleep') return 'idle'
    return 'other'
  }

  const basename = (value) => value.slice(value.lastIndexOf('/') + 1)
  const isAtOrUnder = (path, root) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

  /** Rig root gc qualified the session with (`/r/mem/mem-worker` -> `/r/mem`); only absolute prefixes. */
  function qualifiedRoot(session) {
    const source = session.template ?? session.name
    if (!source.startsWith('/')) return undefined
    const slash = source.lastIndexOf('/')
    return slash > 0 ? source.slice(0, slash) : undefined
  }

  /** Rig association, strongest signal first; an absolute qualifier settles it either way. */
  function belongsToRig({ session, named }, { rigRoot, rigName }) {
    if (rigName !== undefined && (session.rig === rigName || named?.rig === rigName)) return true
    const qualified = qualifiedRoot(session)
    if (qualified) return qualified === rigRoot
    if (rigName !== undefined && session.template?.startsWith(`${rigName}/`)) return true
    return session.workDir !== undefined && isAtOrUnder(session.workDir, rigRoot)
  }

  function configuredRoot(named, input) {
    if (named === undefined) return undefined
    const agent = named.agent === undefined ? undefined : input.config.agents.find((entry) => entry.name === named.agent)
    return named.workDir ?? agent?.workDir
  }

  const identityRoot = (session, named, input) => qualifiedRoot(session) ?? session.workDir ?? configuredRoot(named, input)

  /**
   * The city's own lead (the mayor): with no rig on either side, the identity rooted at the city.
   * With no city root to compare against it is permissive, since a missing mayor looks broken.
   */
  function isCityLead(session, named, input) {
    const rig = named?.rig ?? session.rig
    if (rig !== undefined) return rig === input.hqRigName
    if (input.cityRoot === undefined) return true
    const root = identityRoot(session, named, input)
    return root === undefined || root === input.cityRoot
  }

  const isPinned = (named) => named.mode === 'always' && !named.suspended && named.binding === undefined

  function decodedTmuxName(session) {
    const suffix = `-${session.id}`
    if (!session.name.endsWith(suffix)) return undefined
    const encoded = session.name.slice(0, -suffix.length)
    return encoded.includes('__') ? encoded.replaceAll('__', '.') : undefined
  }

  /** The agent behind a binding-qualified identity (`core.control-dispatcher` -> `control-dispatcher`). */
  function bindingAgentName(session) {
    for (const identity of [session.name, session.alias, session.template, decodedTmuxName(session)]) {
      if (identity === undefined) continue
      const name = basename(identity)
      if (name.includes('.')) return name.slice(name.indexOf('.') + 1)
    }
    return undefined
  }

  function sessionTier(session, named, boundAgent, input) {
    if (boundAgent !== undefined || named?.binding !== undefined) return 'internal'
    if (input.tierSource === 'session-fields')
      return session.configuredNamedSession === true && session.pool === undefined ? 'lead' : 'worker'
    return named !== undefined && isPinned(named) ? 'lead' : 'worker'
  }

  function candidateRig(session, input) {
    if (session.rig !== undefined) return session.rig
    return qualifiedRoot(session) === input.rigRoot ? input.rigName : undefined
  }

  /** gc's projected pool, else the backing agent's namepool (this rig's entry first), else the template. */
  function workerPoolName(session, input) {
    if (session.pool !== undefined) return session.pool
    if (session.template === undefined) return undefined
    const template = basename(session.template)
    const rig = candidateRig(session, input)
    const byName = input.config.agents.filter((agent) => agent.name === template)
    const agent = byName.find((entry) => entry.rig === rig) ?? byName[0]
    return agent?.poolName ?? template
  }

  /** Every name a session answers to, as gc's active-bead matcher sees it, qualified and bare. */
  function identityKeys(session) {
    const keys = [session.id, session.name, session.alias, session.template].flatMap((key) =>
      key === undefined ? [] : [key, basename(key)],
    )
    return [...new Set(keys.filter((key) => key !== ''))]
  }

  /**
   * Tie a session to its named-session config: name or alias first, then the agent template for
   * non-pooled agents only, since a lead's runtime name need not equal its configured one.
   */
  function matchNamedSession(session, config) {
    const keys = new Set(identityKeys(session))
    const byName = config.namedSessions.find((named) => keys.has(named.name) || (named.alias !== undefined && keys.has(named.alias)))
    if (byName) return byName
    const pooled = new Set(config.agents.filter((agent) => agent.pooled).map((agent) => agent.name))
    return config.namedSessions.find((named) => named.agent !== undefined && !pooled.has(named.agent) && keys.has(named.agent))
  }

  /** `gc session <verb>` target: the alias when it is a plain identifier, else the session id. */
  function commandTarget(session) {
    const alias = session.alias ?? session.name
    return alias.includes('/') ? session.id : alias
  }

  function crewCandidate(session, input) {
    const named = matchNamedSession(session, input.config)
    const boundAgent = bindingAgentName(session)
    const tier = sessionTier(session, named, boundAgent, input)
    const poolName = tier === 'worker' ? workerPoolName(session, input) : undefined
    const template = session.template === undefined ? undefined : basename(session.template)
    const member = {
      key: session.id,
      tier,
      label: basename(session.alias ?? session.name),
      target: commandTarget(session),
      identityKeys: identityKeys(session),
      ...(poolName === undefined ? {} : { poolName }),
      ...(tier === 'lead' && isCityLead(session, named, input) ? { cityLead: true } : {}),
      session,
    }
    const classified =
      named !== undefined || input.config.agents.some((agent) => agent.name === template || agent.name === boundAgent)
    return { session, named, member, classified }
  }

  function isDormantCityLead(named, input) {
    if (named.rig !== undefined) return named.rig === input.hqRigName
    if (input.cityRoot === undefined) return true
    const root = configuredRoot(named, input)
    return root === undefined || root === input.cityRoot
  }

  /** A dormant lead scopes like a live one; an identity whose root cannot be placed stays out of a rig. */
  function dormantLeadInScope(named, input) {
    if (input.cityWorkspace) return true
    if (named.rig !== undefined) return named.rig === input.rigName
    const root = configuredRoot(named, input)
    return root !== undefined && isAtOrUnder(root, input.rigRoot)
  }

  /** Pinned identities with no live session: still shown, because their absence is the point. */
  function dormantLeads(input, live) {
    const claimed = new Set(live.flatMap((member) => member.identityKeys))
    return input.config.namedSessions
      .filter(isPinned)
      .filter((named) => dormantLeadInScope(named, input))
      .filter((named) => !claimed.has(named.name) && !claimed.has(named.alias ?? named.name))
      .map((named) => {
        const target = named.alias ?? named.name
        return {
          key: `config:${named.name}`,
          tier: 'lead',
          label: target,
          target,
          ...(isDormantCityLead(named, input) ? { cityLead: true } : {}),
          identityKeys: [...new Set([named.name, named.alias, named.agent].filter(Boolean))],
        }
      })
  }

  /** One card per identity, preferring the one backed by a live session. */
  function dedupeByTarget(members) {
    const byTarget = new Map()
    for (const member of members) {
      const existing = byTarget.get(member.target)
      if (existing === undefined || (existing.session === undefined && member.session)) byTarget.set(member.target, member)
    }
    return [...byTarget.values()]
  }

  const activityRank = (member) => BANDS.indexOf(activityBand(member.session?.state))

  /** Tier, then the city's own lead, then pool, then running before idle, then label. */
  function byCrewOrder(left, right) {
    return (
      TIERS.indexOf(left.tier) - TIERS.indexOf(right.tier) ||
      Number(right.cityLead ?? false) - Number(left.cityLead ?? false) ||
      (left.poolName ?? '').localeCompare(right.poolName ?? '') ||
      activityRank(left) - activityRank(right) ||
      left.label.localeCompare(right.label)
    )
  }

  /**
   * The crew a workspace sees. `cityWorkspace` shows everything; otherwise only sessions and
   * pinned identities of the rig at `rigRoot` / `rigName`.
   */
  function deriveCrew(input) {
    const scoped = input.sessions
      .map((session) => crewCandidate(session, input))
      .filter((candidate) => input.cityWorkspace || belongsToRig(candidate, input))
    const live = scoped.map(({ member }) => member)
    const members = dedupeByTarget([...live, ...dormantLeads(input, live)])
      .sort(byCrewOrder)
      .filter((member) => input.includeInternals || member.tier !== 'internal')
    return {
      members,
      tierSource: input.tierSource,
      scope: input.cityWorkspace ? 'city' : 'rig',
      diagnostics: {
        namedSessions: input.config.namedSessions.length,
        pinned: input.config.namedSessions.filter(isPinned).length,
        unmatched: scoped.filter((candidate) => !candidate.classified).map((candidate) => candidate.member.label),
      },
    }
  }

  /** Identity keys more than one member claims; an assignee naming only such a key names nobody. */
  function ambiguousIdentityKeys(members) {
    const owners = new Map()
    for (const member of members)
      for (const key of new Set(member.identityKeys)) owners.set(key, (owners.get(key) ?? 0) + 1)
    return new Set([...owners].filter(([, count]) => count > 1).map(([key]) => key))
  }

  /** gc's `active_bead` wins; otherwise an in-progress bead whose assignee is exactly one of the member's keys. */
  function joinBead(member, inFlight, byId, ambiguous) {
    const projected = member.session?.activeBead
    if (projected !== undefined) {
      const issue = byId.get(projected)
      return { id: projected, title: issue?.title ?? projected }
    }
    const issue = inFlight.find(
      (candidate) =>
        candidate.assignee !== undefined && !ambiguous.has(candidate.assignee) && member.identityKeys.includes(candidate.assignee),
    )
    return issue ? { id: issue.id, title: issue.title } : undefined
  }

  /** Leads, workers grouped by pool, and internals, each card carrying the bead its member is working. */
  function crewView(members, issues) {
    const inFlight = issues.filter((issue) => issue.status === 'in_progress')
    const byId = new Map(issues.map((issue) => [issue.id, issue]))
    const ambiguous = ambiguousIdentityKeys(members)
    const cards = members.map((member) => {
      const bead = joinBead(member, inFlight, byId, ambiguous)
      return bead ? { member, bead } : { member }
    })
    const workers = cards.filter((card) => card.member.tier === 'worker')
    const poolLabels = [...new Set(workers.map((card) => card.member.poolName ?? 'workers'))]
    return {
      leads: cards.filter((card) => card.member.tier === 'lead'),
      pools: poolLabels.map((label) => ({
        label,
        cards: workers.filter((card) => (card.member.poolName ?? 'workers') === label),
      })),
      internals: cards.filter((card) => card.member.tier === 'internal'),
      total: cards.length,
    }
  }

  const api = Object.freeze({ deriveCrew, crewView, activityBand })
  if (typeof module === 'object') module.exports = api
  else window.crew = api
})()
