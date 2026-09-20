import type { BeadIssue, GasCityCrew, GasCityCrewMember } from '../../../shared'
import { sortBeads } from './beads-model'

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

/** A non-closed bead assigned to a crew member, other than the one it is working. */
export interface HeldBead {
  readonly id: string
  readonly title: string
  /** `status === 'in_progress'`; a boolean so the renderer never styles from an unknown bd status. */
  readonly inFlight: boolean
}

export interface CrewCard {
  readonly member: GasCityCrewMember
  readonly bead?: CrewBead
  /** Everything else the member holds, in-flight first, then bead order. */
  readonly held: readonly HeldBead[]
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

export function buildCrewView(crew: GasCityCrew, issues: readonly BeadIssue[]): CrewView {
  const inFlight = issues.filter((issue) => issue.status === 'in_progress')
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const ambiguous = ambiguousIdentityKeys(crew.members)
  const cards = crew.members.map((member) => {
    const bead = joinBead(member, inFlight, byId, ambiguous)
    const held = heldBeads(member, issues, bead, ambiguous)
    return { member, held, ...(bead ? { bead } : {}) }
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
  ambiguous: ReadonlySet<string>,
): CrewBead | undefined {
  const projected = member.session?.activeBead
  if (projected !== undefined) {
    const issue = byId.get(projected)
    return issue ? beadContext(issue) : { id: projected, title: projected }
  }
  const issue = inFlight.find((candidate) => holdsBead(member, candidate, ambiguous))
  return issue ? beadContext(issue) : undefined
}

/**
 * Identity keys claimed by more than one crew member. A bare session name or
 * template basename recurs once per rig (`polecat` in mem and in hq), so an
 * assignee that only names the bare key names nobody in particular; the
 * rig-qualified path and the session id stay unique and keep joining.
 */
export function ambiguousIdentityKeys(
  members: readonly GasCityCrewMember[],
): ReadonlySet<string> {
  const owners = new Map<string, number>()
  for (const member of members) {
    for (const key of new Set(member.identityKeys)) {
      owners.set(key, (owners.get(key) ?? 0) + 1)
    }
  }
  return new Set([...owners].filter(([, count]) => count > 1).map(([key]) => key))
}

/**
 * Whether a bead's assignee names this crew member: exact membership of the
 * assignee string in the member's identity keys, nothing looser.
 *
 * The rule is fixed by what bd assignees look like in a live city (read from
 * a running city on 2026-09-12): a bare gc alias (`city-infra-pl`,
 * `gascity-pl`, `mayor`), an absolute agent-directory path that is the
 * session's template (`/home/dev/gas-city/goal-3-decisions`), a bare template
 * basename (`goal-4-context`), or a non-session identity (`sjarmak`,
 * `controller`, `codex-w1h`). gc's crew derivation already emits both the
 * qualified and basename form of a session's id, name, alias and template into
 * `identityKeys`, so exact membership covers the first three shapes, and the
 * fourth correctly stays unjoined. A key in `ambiguous` (claimed by several
 * members crew-wide) joins nobody: the assignee then does not name one member.
 *
 * Prefix matching and basename-of-assignee matching are deliberately excluded:
 * `/home/dev/gas-city/city-infra-worker-1` must never join a session whose
 * template is `/home/dev/gas-city/city-infra-worker`. The rule is the one
 * `joinBead` uses, so the panel and gc's scheduler agree about ownership.
 */
export function holdsBead(
  member: GasCityCrewMember,
  issue: BeadIssue,
  ambiguous: ReadonlySet<string> = new Set(),
): boolean {
  return (
    issue.assignee !== undefined &&
    !ambiguous.has(issue.assignee) &&
    member.identityKeys.includes(issue.assignee)
  )
}

/**
 * The crew member an identity names, when exactly one does.
 *
 * Exact membership in a member's identity keys, with keys more than one member
 * claims left unresolved — the same rule that decides which bead a member
 * holds. A bead's assignee is a name, not a session, so this is how a surface
 * holding only the assignee reaches the session behind it without guessing from
 * labels or timing (ADR-046).
 */
export function memberForIdentity(
  members: readonly GasCityCrewMember[],
  identity: string,
): GasCityCrewMember | undefined {
  if (ambiguousIdentityKeys(members).has(identity)) return undefined
  return members.find((member) => member.identityKeys.includes(identity))
}

function heldBeads(
  member: GasCityCrewMember,
  issues: readonly BeadIssue[],
  active: CrewBead | undefined,
  ambiguous: ReadonlySet<string>,
): readonly HeldBead[] {
  const owned = issues.filter(
    (issue) =>
      issue.status !== 'closed' &&
      issue.id !== active?.id &&
      holdsBead(member, issue, ambiguous),
  )
  const inProgress = owned.filter((issue) => issue.status === 'in_progress')
  const rest = owned.filter((issue) => issue.status !== 'in_progress')
  return [...sortBeads(inProgress), ...sortBeads(rest)].map((issue) => ({
    id: issue.id,
    title: issue.title,
    inFlight: issue.status === 'in_progress',
  }))
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
