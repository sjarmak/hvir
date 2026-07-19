import {
  classifyIssueType,
  type BeadDependencyEdge,
  type BeadGate,
  type BeadIssue,
  type BeadsSnapshot,
  type DispatchabilitySource,
} from '../../../shared'

/**
 * Pure classification for the beads rail panel. Turns a raw {@link BeadsSnapshot}
 * into the human information architecture — Needs you / In flight / Ready next /
 * Planned / Blocked / Completed — answering "what needs me, what is really in
 * flight, what is actually next, what is merely planned, what is blocked."
 *
 * All type/executability policy comes from the shared taxonomy so it is never
 * re-derived here, and no state is ever inferred from title/description/notes
 * keywords. Unknown records are surfaced as data-hygiene issues, never silently
 * treated as executable.
 */

export type BeadsSectionKey =
  | 'needsYou'
  | 'inFlight'
  | 'readyToShip'
  | 'readyNext'
  | 'planned'
  | 'blocked'
  | 'completed'

/** A resolved reference to another bead — id turned into a human title + state. */
export interface DependencyRef {
  readonly id: string
  readonly title: string
  readonly status: string
}

export interface BeadCard {
  readonly issue: BeadIssue
  /** The parent epic/outcome, resolved to a title when available. */
  readonly parentOutcome?: DependencyRef
  /** Unresolved blockers (open beads that must close first), with titles + state. */
  readonly blockedBy: readonly DependencyRef[]
  /** How many downstream items this bead unlocks (reverse dependency count). */
  readonly unlocksCount: number
  /** Titles of the unlocked items, for on-demand expansion. */
  readonly unlocks: readonly DependencyRef[]
  /** Active owner, when assigned. */
  readonly owner?: string
  /** In-flight liveness signal: best-effort, timestamp/assignment based. */
  readonly liveness?: 'live' | 'stale' | 'unknown'
  /** The single most useful next action to unblock this bead. */
  readonly nextUnblock?: { readonly action: string; readonly owner?: string }
  /** Ready-to-ship gate state (branch-ready, needs review, …), from typed metadata. */
  readonly shipState?: string
}

/** An outcome (epic) with the planned leaf work nested under it. */
export interface BeadGroup {
  readonly outcome: BeadIssue
  readonly cards: readonly BeadCard[]
}

export interface BeadsSection {
  readonly key: BeadsSectionKey
  readonly label: string
  readonly cards: readonly BeadCard[]
  /** Planned only: outcome-grouped leaf work. */
  readonly groups?: readonly BeadGroup[]
  /** Total human work items in this section (flat cards + grouped cards). */
  readonly count: number
  /** Optional caveat shown under the heading (e.g. structural-approximation note). */
  readonly note?: string
}

/** A gate resolved to what it blocks — the backbone of "Needs you". */
export interface GateItem {
  readonly gate: BeadGate
  readonly blocks?: DependencyRef
}

export interface BeadsView {
  readonly sections: readonly BeadsSection[]
  readonly gates: readonly GateItem[]
  /** Unknown-type or incomplete records — surfaced, not guessed. */
  readonly dataHygiene: readonly BeadIssue[]
  readonly dispatchabilitySource: DispatchabilitySource
  /** Orchestration/infra beads, hidden from human counts (debug view only). */
  readonly orchestrationIssues: readonly BeadIssue[]
  /** Full blocking-edge set, offered only in the expanded/debug view. */
  readonly dependencies: readonly BeadDependencyEdge[]
}

export interface ClassifyOptions {
  /** "Now" in epoch ms, for the in-flight staleness signal. Defaults to Date.now(). */
  readonly now?: number
  /** How old an in-flight bead's last update may be before it reads as stale. */
  readonly staleAfterMs?: number
}

const SECTION_LABELS: Record<BeadsSectionKey, string> = {
  needsYou: 'Needs you',
  inFlight: 'In flight',
  readyToShip: 'Ready to ship',
  readyNext: 'Ready next',
  planned: 'Planned',
  blocked: 'Blocked',
  completed: 'Completed recently',
}

/**
 * Until the GC API supplies real scheduler dispatchability, this section is only
 * a structural approximation — dependency-ready leaf work with no typed
 * dispatch signal — so it must NOT wear the confident "Ready next" title.
 */
const DEPENDENCY_READY_LABEL = 'Dependency-ready / needs classification'

const SECTION_ORDER: readonly BeadsSectionKey[] = [
  'needsYou',
  'inFlight',
  'readyToShip',
  'readyNext',
  'planned',
  'blocked',
  'completed',
]

/** In-flight work whose last update is older than this reads as "may be stale". */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000

export function classifyBeads(
  snapshot: BeadsSnapshot,
  options: ClassifyOptions = {},
): BeadsView {
  const now = options.now ?? Date.now()
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS

  // Tolerate an older-shape snapshot (e.g. a main process that predates the
  // enrichment fields): default every optional collection so the panel renders
  // rather than crashing on a missing array.
  const issues = snapshot.issues ?? []
  const dependencyEdges = snapshot.dependencies ?? []
  const gateList = snapshot.gates ?? []
  const dispatchabilitySource = snapshot.dispatchabilitySource ?? 'structural'

  const byId = new Map<string, BeadIssue>()
  for (const issue of issues) byId.set(issue.id, issue)

  const dispatchable = new Set(snapshot.dispatchableIds ?? [])

  // blockedBy: ids that block me. unlocks: ids I block (reverse edges).
  const blockedBy = new Map<string, string[]>()
  const unlocks = new Map<string, string[]>()
  for (const edge of dependencyEdges) {
    push(blockedBy, edge.blockedId, edge.blockerId)
    push(unlocks, edge.blockerId, edge.blockedId)
  }

  const ref = (id: string): DependencyRef | undefined => {
    const issue = byId.get(id)
    if (!issue) return undefined
    return { id, title: issue.title, status: issue.status }
  }

  /** Blockers that are still open (present in the non-closed set). */
  const unresolvedBlockers = (id: string): readonly DependencyRef[] =>
    (blockedBy.get(id) ?? [])
      .map(ref)
      .filter((entry): entry is DependencyRef => entry !== undefined)

  const buildCard = (issue: BeadIssue): BeadCard => {
    const blockers = unresolvedBlockers(issue.id)
    const unlockRefs = (unlocks.get(issue.id) ?? [])
      .map(ref)
      .filter((entry): entry is DependencyRef => entry !== undefined)
    const firstBlocker = blockers[0]
    return {
      issue,
      ...(issue.parent && ref(issue.parent) ? { parentOutcome: ref(issue.parent) } : {}),
      blockedBy: blockers,
      unlocksCount: unlockRefs.length,
      unlocks: unlockRefs,
      ...(issue.assignee ? { owner: issue.assignee } : {}),
      ...(firstBlocker
        ? {
            nextUnblock: {
              action: `Resolve “${firstBlocker.title}”`,
              ...blockerOwner(byId, firstBlocker.id),
            },
          }
        : {}),
    }
  }

  const buckets: Record<BeadsSectionKey, BeadCard[]> = {
    needsYou: [],
    inFlight: [],
    readyToShip: [],
    readyNext: [],
    planned: [],
    blocked: [],
    completed: [],
  }
  const orchestrationIssues: BeadIssue[] = []
  const dataHygiene: BeadIssue[] = []

  for (const issue of issues) {
    const category = classifyIssueType(issue.issueType)
    // Orchestration/infra/gate-type beads are machinery: hidden from the human
    // view unless the debug toggle asks for them.
    if (category === 'orchestration' || category === 'infra' || category === 'gate') {
      orchestrationIssues.push(issue)
      continue
    }
    // Unknown type = missing semantics. Surface it, never guess it executable.
    if (category === 'unknown') {
      dataHygiene.push(issue)
      continue
    }

    // Deterministic precedence — the same order the correction list specifies.
    // Each rule uses typed fields only; no title/description/notes keywords.
    const card = buildCard(issue)
    if (needsHuman(issue, category)) {
      buckets.needsYou.push(card)
    } else if (issue.status === 'in_progress') {
      buckets.inFlight.push(withLiveness(card, now, staleAfterMs))
    } else if (issue.status === 'blocked' || card.blockedBy.length > 0) {
      // A real, unresolved open blocker outranks any structural readiness: in a
      // split/degraded store bd can still list a plainly-blocked bead as ready,
      // so the typed dependency edge wins.
      buckets.blocked.push(card)
    } else if (shipStateOf(issue, category) !== undefined) {
      buckets.readyToShip.push({ ...card, shipState: shipStateOf(issue, category) })
    } else if (issue.status === 'deferred' || isFutureDefer(issue.deferUntil, now)) {
      buckets.planned.push(card)
    } else if (category === 'outcome') {
      // Epics are planned outcomes (grouped below).
      buckets.planned.push(card)
    } else if (dispatchable.has(issue.id)) {
      buckets.readyNext.push(card)
    } else {
      // Dependency-ready-but-not-dispatchable, or plain open backlog: planned,
      // never mixed into executable queue depth.
      buckets.planned.push(card)
    }
  }

  const orderedDataHygiene = [...dataHygiene].sort(compareIssues)

  const structural = dispatchabilitySource === 'structural'
  const sections: BeadsSection[] = SECTION_ORDER.map((key) => {
    if (key === 'planned') return buildPlannedSection(buckets.planned, byId)
    const cards = sortCards(buckets[key])
    // Without a real dispatchability predicate this section is only dependency-
    // ready work, so it is honestly titled and never promoted to "Ready next".
    const label =
      key === 'readyNext' && structural ? DEPENDENCY_READY_LABEL : SECTION_LABELS[key]
    const section: BeadsSection = { key, label, cards, count: cards.length }
    if (key === 'readyNext' && structural) {
      return {
        ...section,
        note:
          'Structural approximation — no scheduler dispatchability predicate configured. ' +
          'These are dependency-ready, not verified next.',
      }
    }
    return section
  })

  const gates: GateItem[] = gateList.map((gate) => ({
    gate,
    ...(gate.blockedId && ref(gate.blockedId) ? { blocks: ref(gate.blockedId) } : {}),
  }))

  return {
    sections,
    gates,
    dataHygiene: orderedDataHygiene,
    dispatchabilitySource,
    orchestrationIssues: [...orchestrationIssues].sort(compareIssues),
    dependencies: dependencyEdges,
  }
}

/** Planned groups epics as outcomes with their leaf children nested underneath. */
function buildPlannedSection(
  cards: readonly BeadCard[],
  byId: ReadonlyMap<string, BeadIssue>,
): BeadsSection {
  const epicIds = new Set(
    cards
      .filter((card) => classifyIssueType(card.issue.issueType) === 'outcome')
      .map((c) => c.issue.id),
  )
  const groups: BeadGroup[] = []
  const grouped = new Map<string, BeadCard[]>()
  const flat: BeadCard[] = []

  for (const card of cards) {
    const parent = card.issue.parent
    if (classifyIssueType(card.issue.issueType) === 'outcome') continue // outcomes head their own group
    if (parent && epicIds.has(parent)) {
      push(grouped, parent, card)
    } else {
      flat.push(card)
    }
  }

  for (const id of epicIds) {
    const outcome = byId.get(id)
    if (!outcome) continue
    groups.push({ outcome, cards: sortCards(grouped.get(id) ?? []) })
  }
  groups.sort((a, b) => compareIssues(a.outcome, b.outcome))

  const groupedCount = groups.reduce((sum, group) => sum + group.cards.length, 0)
  const sortedFlat = sortCards(flat)
  return {
    key: 'planned',
    label: SECTION_LABELS.planned,
    cards: sortedFlat,
    groups,
    count: sortedFlat.length + groups.length + groupedCount,
  }
}

/** Best-effort in-flight liveness: a dead assignment or a stale last update. */
function withLiveness(card: BeadCard, now: number, staleAfterMs: number): BeadCard {
  if (!card.owner) return { ...card, liveness: 'stale' }
  const updated = card.issue.updatedAt ? Date.parse(card.issue.updatedAt) : NaN
  if (Number.isNaN(updated)) return { ...card, liveness: 'unknown' }
  return { ...card, liveness: now - updated > staleAfterMs ? 'stale' : 'live' }
}

function blockerOwner(
  byId: ReadonlyMap<string, BeadIssue>,
  blockerId: string,
): { readonly owner?: string } {
  const owner = byId.get(blockerId)?.assignee
  return owner ? { owner } : {}
}

function isDecision(issueType: string): boolean {
  const lower = issueType.trim().toLowerCase()
  return lower === 'decision' || lower === 'dec' || lower === 'adr'
}

/**
 * Does this bead await a human? Typed signals only: an open decision, or a
 * `needs-human` label. Never inferred from a "Decide:" title or prose.
 */
function needsHuman(issue: BeadIssue, category: string): boolean {
  if (
    category === 'outcome' &&
    isDecision(issue.issueType) &&
    issue.status !== 'closed'
  ) {
    return true
  }
  return issue.labels.some((label) => label.toLowerCase() === 'needs-human')
}

/** Human-readable gate labels for the typed `gc.outcome` values. */
const SHIP_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  'branch-ready': 'Branch ready',
  'review-ready': 'Needs review',
  'deploy-ready': 'Ready to deploy',
  'deploy-gated': 'Deploy gated',
  'stacked-on-pr': 'Stacked on PR',
}

/**
 * The ship-gate state, or undefined if this is not ship work. Driven only by
 * typed fields — `gc.outcome`/`gc.no_land` metadata or the `merge-request`
 * type — never by parsing "branch-ready" out of a title or note.
 */
function shipStateOf(issue: BeadIssue, category: string): string | undefined {
  const outcome = issue.metadata?.['gc.outcome']?.trim().toLowerCase()
  if (outcome && outcome in SHIP_OUTCOME_LABELS) return SHIP_OUTCOME_LABELS[outcome]
  if (metaTruthy(issue.metadata?.['gc.no_land'])) return 'No-land (do not merge)'
  const pr = issue.metadata?.['gc.pr']
  if (pr) return `Waiting for PR ${pr.startsWith('#') ? pr : `#${pr}`}`
  if (category === 'ship') return 'Merge request'
  return undefined
}

/** A metadata flag reads as set unless it is empty, "0", "false", or "no". */
function metaTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const lower = value.trim().toLowerCase()
  return lower !== '' && lower !== '0' && lower !== 'false' && lower !== 'no'
}

function isFutureDefer(deferUntil: string | undefined, now: number): boolean {
  if (!deferUntil) return false
  const when = Date.parse(deferUntil)
  return !Number.isNaN(when) && when > now
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

/** Highest priority first, then most recently updated, then stable by id. */
export function sortBeads(issues: readonly BeadIssue[]): readonly BeadIssue[] {
  return [...issues].sort(compareIssues)
}

function sortCards(cards: readonly BeadCard[]): readonly BeadCard[] {
  return [...cards].sort((a, b) => compareIssues(a.issue, b.issue))
}

function compareIssues(left: BeadIssue, right: BeadIssue): number {
  if (left.priority !== right.priority) return left.priority - right.priority
  const updated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
  if (updated !== 0) return updated
  return left.id.localeCompare(right.id)
}

export function priorityLabel(priority: number): string {
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) return 'P?'
  return `P${priority}`
}
