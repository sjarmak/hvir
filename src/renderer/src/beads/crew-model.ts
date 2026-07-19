import type { BeadIssue, GasCityCrew, GasCityCrewMember } from '../../../shared'

/**
 * Pure shaping for the crew section: the bead join and the tier grouping the
 * panel renders. No fetching, no React — so the join rules that have to agree
 * with gc's scheduler are unit-testable in isolation.
 */

export interface CrewBead {
  readonly id: string
  readonly title: string
  /** Formula the bead runs under, when its `gc.*` metadata carries one. */
  readonly formula?: string
  /** Molecule/convoy context, when present. */
  readonly molecule?: string
}

export interface CrewCard {
  readonly member: GasCityCrewMember
  readonly bead?: CrewBead
}

export interface CrewGroup {
  readonly key: string
  readonly label: string
  readonly cards: readonly CrewCard[]
}

export interface CrewView {
  readonly leads: readonly CrewCard[]
  /** Workers grouped by pool, which is the worker-type label. */
  readonly pools: readonly CrewGroup[]
  readonly internals: readonly CrewCard[]
  readonly total: number
}

export function buildCrewView(
  crew: GasCityCrew,
  issues: readonly BeadIssue[],
): CrewView {
  const inFlight = issues.filter((issue) => issue.status === 'in_progress')
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const cards = crew.members.map((member) => {
    const bead = joinBead(member, inFlight, byId)
    return bead === undefined ? { member } : { member, bead }
  })
  const pools = new Map<string, CrewCard[]>()
  for (const card of cards) {
    if (card.member.tier !== 'worker') continue
    const label = card.member.poolName ?? 'workers'
    const group = pools.get(label)
    if (group) group.push(card)
    else pools.set(label, [card])
  }
  return {
    leads: cards.filter((card) => card.member.tier === 'lead'),
    pools: [...pools.entries()].map(([label, groupCards]) => ({
      key: label,
      label,
      cards: groupCards,
    })),
    internals: cards.filter((card) => card.member.tier === 'internal'),
    total: cards.length,
  }
}

/**
 * The bead a crew member is working. gc's own `active_bead` projection wins when
 * present; otherwise the assignee is matched against the same identity set gc's
 * active-bead matcher uses, so the panel and the scheduler never disagree about
 * who owns what.
 */
function joinBead(
  member: GasCityCrewMember,
  inFlight: readonly BeadIssue[],
  byId: ReadonlyMap<string, BeadIssue>,
): CrewBead | undefined {
  const projected = member.session?.activeBead
  if (projected !== undefined) {
    const issue = byId.get(projected)
    return issue ? beadContext(issue) : { id: projected, title: projected }
  }
  const keys = new Set(member.identityKeys)
  const issue = inFlight.find(
    (candidate) => candidate.assignee !== undefined && keys.has(candidate.assignee),
  )
  return issue ? beadContext(issue) : undefined
}

function beadContext(issue: BeadIssue): CrewBead {
  const metadata = issue.metadata ?? {}
  const formula = metadata['gc.formula']
  const molecule = metadata['gc.molecule'] ?? metadata['gc.convoy']
  return {
    id: issue.id,
    title: issue.title,
    ...(formula ? { formula } : {}),
    ...(molecule ? { molecule } : {}),
  }
}
