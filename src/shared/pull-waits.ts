import type { PullReviewer, PullSummary, PullsSnapshot } from './github'

/**
 * Who holds the ball on a pull request and since when (ADR-976). A pure derivation over
 * the shared pull summary; main and the renderer both consume it, neither restates it.
 */

export type PullHolderKind = 'user' | 'team' | 'author' | 'nobody'

export interface PullHolder {
  readonly person?: string
  readonly kind: PullHolderKind
  /** Epoch ms. */
  readonly since: number
}

export type PullWaitStatus = 'draft' | 'review' | 'changes' | 'approved' | 'unassigned'

export interface PullWait {
  readonly status: PullWaitStatus
  readonly holders: readonly PullHolder[]
}

export type PullWaitList = 'needs' | 'waiting' | 'drafts'

export interface PullWaitRow {
  readonly pull: PullSummary
  readonly list: PullWaitList
  readonly reason: string
  /** Epoch ms of the ask this row counts from. */
  readonly since: number
  readonly waitingOn: readonly string[]
}

type OpenWaitStatus = Exclude<PullWaitStatus, 'draft'>

interface OpenWait extends PullWait {
  readonly status: OpenWaitStatus
}

const NEEDS_REASON: Record<Exclude<OpenWaitStatus, 'review'>, string> = {
  approved: 'Ready to merge',
  changes: 'Changes requested',
  unassigned: 'No reviewer yet',
}

export function laterOf(a?: number, b?: number): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function parseIso(value?: string): number | undefined {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

function maxOf(values: readonly (number | undefined)[]): number | undefined {
  return values.reduce<number | undefined>(
    (best, value) => laterOf(best, value),
    undefined,
  )
}

function minOf(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values)
}

/** A team is named by its combined `org/slug`; people and teams both read as `@name`. */
export function pullHandle(name: string): string {
  return `@${name.slice(name.indexOf('/') + 1)}`
}

function requestedSince(reviewer: PullReviewer, pull: PullSummary, now: number): number {
  return (
    laterOf(parseIso(reviewer.requestedAt), parseIso(pull.readyForReviewAt)) ??
    parseIso(pull.createdAt) ??
    now
  )
}

function readySince(pull: PullSummary, now: number): number {
  return parseIso(pull.readyForReviewAt) ?? parseIso(pull.createdAt) ?? now
}

function authorSince(
  reviewers: readonly PullReviewer[],
  pull: PullSummary,
  now: number,
): number {
  return (
    maxOf(reviewers.map((reviewer) => parseIso(reviewer.reviewedAt))) ??
    readySince(pull, now)
  )
}

/**
 * GitHub's review decision is null in a repository without a required-review rule, so an
 * approval there is read from the reviewers; a decision of required or changes stands.
 */
function isApproved(pull: PullSummary, approvals: readonly PullReviewer[]): boolean {
  return pull.review === 'approved' || (pull.review === 'none' && approvals.length > 0)
}

function deriveOpenHolders(pull: PullSummary, now: number): OpenWait {
  const pending = pull.reviewers.filter((reviewer) => reviewer.pending)
  if (pending.length > 0) {
    return {
      status: 'review',
      holders: pending.map((reviewer) => ({
        person: reviewer.login,
        kind: reviewer.kind,
        since: requestedSince(reviewer, pull, now),
      })),
    }
  }
  const author = (status: OpenWaitStatus, since: number): OpenWait => ({
    status,
    holders: [{ person: pull.author, kind: 'author', since }],
  })
  const changes = pull.reviewers.filter(
    (reviewer) => reviewer.reviewState === 'changes-requested',
  )
  if (changes.length > 0) return author('changes', authorSince(changes, pull, now))
  const approvals = pull.reviewers.filter(
    (reviewer) => reviewer.reviewState === 'approved',
  )
  if (isApproved(pull, approvals)) {
    return author('approved', authorSince(approvals, pull, now))
  }
  return {
    status: 'unassigned',
    holders: [{ kind: 'nobody', since: readySince(pull, now) }],
  }
}

export function deriveHolders(pull: PullSummary, now: number): PullWait {
  return pull.draft ? { status: 'draft', holders: [] } : deriveOpenHolders(pull, now)
}

function row(
  pull: PullSummary,
  list: PullWaitList,
  reason: string,
  since: number,
  waitingOn: readonly string[] = [],
): PullWaitRow {
  return { pull, list, reason, since, waitingOn }
}

function answeredSince(pull: PullSummary, since: number): boolean {
  const reviewed = parseIso(pull.viewerReviewedAt)
  return reviewed !== undefined && reviewed >= since
}

function inboundRow(
  pull: PullSummary,
  viewer: string,
  now: number,
): PullWaitRow | undefined {
  if (pull.draft) return undefined
  const direct = pull.reviewers.find(
    (reviewer) =>
      reviewer.pending && reviewer.kind === 'user' && reviewer.login === viewer,
  )
  if (direct) {
    const reason =
      parseIso(pull.viewerReviewedAt) === undefined ? 'Requested' : 'Re-requested'
    return row(pull, 'needs', reason, requestedSince(direct, pull, now))
  }
  const teams = pull.reviewers.filter(
    (reviewer) => reviewer.pending && reviewer.kind === 'team',
  )
  const teamSince = minOf(teams.map((team) => requestedSince(team, pull, now)))
  if (teamSince !== undefined) {
    if (answeredSince(pull, teamSince)) return undefined
    return row(
      pull,
      'needs',
      `via ${teams.map((team) => pullHandle(team.login)).join(', ')}`,
      teamSince,
    )
  }
  const assigned = parseIso(pull.viewerAssignedAt)
  if (assigned !== undefined) {
    return answeredSince(pull, assigned)
      ? undefined
      : row(pull, 'needs', 'Assigned', assigned)
  }
  return row(pull, 'needs', 'Requested', readySince(pull, now))
}

function waitingRow(pull: PullSummary, wait: OpenWait, since: number): PullWaitRow {
  const [only] = wait.holders
  const soleTeam =
    wait.holders.length === 1 && only?.kind === 'team' ? only.person : undefined
  const reason = soleTeam === undefined ? 'Waiting' : `via ${pullHandle(soleTeam)}`
  const waitingOn = wait.holders.flatMap((holder) =>
    holder.person === undefined ? [] : [holder.person],
  )
  return row(pull, 'waiting', reason, since, waitingOn)
}

function authoredRow(pull: PullSummary, now: number): PullWaitRow {
  const updated = parseIso(pull.updatedAt) ?? now
  if (pull.draft) return row(pull, 'drafts', 'Draft', updated)
  if (pull.checks === 'failing') {
    return row(pull, 'needs', 'CI failing', parseIso(pull.headCommittedAt) ?? updated)
  }
  const wait = deriveOpenHolders(pull, now)
  const since = Math.min(...wait.holders.map((holder) => holder.since))
  if (wait.status === 'review') return waitingRow(pull, wait, since)
  return row(pull, 'needs', NEEDS_REASON[wait.status], since)
}

function uniqueOpen(pulls: readonly PullSummary[]): readonly PullSummary[] {
  return pulls.filter(
    (pull, index) =>
      pull.state === 'open' &&
      pulls.findIndex((other) => other.number === pull.number) === index,
  )
}

const byOldestAsk = (a: PullWaitRow, b: PullWaitRow): number => a.since - b.since
const byNewestAsk = (a: PullWaitRow, b: PullWaitRow): number => b.since - a.since

/**
 * One row per open pull request: inbound asks and the viewer's own pull requests whose
 * ball came back under `needs`, those held by others under `waiting`, drafts under
 * `drafts`. Needs and waiting list the oldest ask first; drafts the newest.
 */
export function pullWaitRows(
  snapshot: PullsSnapshot,
  now: number,
): readonly PullWaitRow[] {
  const authored = uniqueOpen(snapshot.authored)
  const own = new Set(authored.map((pull) => pull.number))
  const inbound = uniqueOpen(snapshot.reviewRequested).filter(
    (pull) => pull.author !== snapshot.viewer && !own.has(pull.number),
  )
  const rows = [
    ...inbound.flatMap((pull) => inboundRow(pull, snapshot.viewer, now) ?? []),
    ...authored.map((pull) => authoredRow(pull, now)),
  ]
  const ofList = (list: PullWaitList): PullWaitRow[] =>
    rows.filter((item) => item.list === list)
  return [
    ...ofList('needs').sort(byOldestAsk),
    ...ofList('waiting').sort(byOldestAsk),
    ...ofList('drafts').sort(byNewestAsk),
  ]
}
