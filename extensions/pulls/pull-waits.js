/* global window, module */
/**
 * Who holds the ball on a pull request and since when (ADR-976), ported from
 * src/shared/pull-waits.ts. Pure: summaries in, ordered rows out.
 */
;(() => {
  const NEEDS_REASON = {
    approved: 'Ready to merge',
    changes: 'Changes requested',
    unassigned: 'No reviewer yet',
  }

  function laterOf(a, b) {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.max(a, b)
  }

  function parseIso(value) {
    if (value === undefined) return undefined
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }

  const maxOf = (values) => values.reduce((best, value) => laterOf(best, value), undefined)

  /** A team is named by its combined `org/slug`; people and teams both read as `@name`. */
  const pullHandle = (name) => `@${name.slice(name.indexOf('/') + 1)}`

  const readySince = (pull, now) => parseIso(pull.readyForReviewAt) ?? parseIso(pull.createdAt) ?? now

  const requestedSince = (reviewer, pull, now) =>
    laterOf(parseIso(reviewer.requestedAt), parseIso(pull.readyForReviewAt)) ?? parseIso(pull.createdAt) ?? now

  const authorSince = (reviewers, pull, now) =>
    maxOf(reviewers.map((reviewer) => parseIso(reviewer.reviewedAt))) ?? readySince(pull, now)

  /** The review decision is null without a required-review rule, so approval is read from reviewers. */
  const isApproved = (pull, approvals) =>
    pull.review === 'approved' || (pull.review === 'none' && approvals.length > 0)

  function deriveOpenHolders(pull, now) {
    const pending = pull.reviewers.filter((reviewer) => reviewer.pending)
    if (pending.length > 0) {
      const holders = pending.map((reviewer) => ({
        person: reviewer.login,
        kind: reviewer.kind,
        since: requestedSince(reviewer, pull, now),
      }))
      return { status: 'review', holders }
    }
    const author = (status, since) => ({ status, holders: [{ person: pull.author, kind: 'author', since }] })
    const changes = pull.reviewers.filter((reviewer) => reviewer.reviewState === 'changes-requested')
    if (changes.length > 0) return author('changes', authorSince(changes, pull, now))
    const approvals = pull.reviewers.filter((reviewer) => reviewer.reviewState === 'approved')
    if (isApproved(pull, approvals)) return author('approved', authorSince(approvals, pull, now))
    return { status: 'unassigned', holders: [{ kind: 'nobody', since: readySince(pull, now) }] }
  }

  const row = (pull, list, reason, since, waitingOn = []) => ({ pull, list, reason, since, waitingOn })

  function answeredSince(pull, since) {
    const reviewed = parseIso(pull.viewerReviewedAt)
    return reviewed !== undefined && reviewed >= since
  }

  /** An inbound ask: a direct request, a request through a team, or an assignment. */
  function inboundRow(pull, viewer, now) {
    if (pull.draft) return undefined
    const direct = pull.reviewers.find(
      (reviewer) => reviewer.pending && reviewer.kind === 'user' && reviewer.login === viewer,
    )
    if (direct) {
      const reason = parseIso(pull.viewerReviewedAt) === undefined ? 'Requested' : 'Re-requested'
      return row(pull, 'needs', reason, requestedSince(direct, pull, now))
    }
    const teams = pull.reviewers.filter((reviewer) => reviewer.pending && reviewer.kind === 'team')
    if (teams.length > 0) {
      const since = Math.min(...teams.map((team) => requestedSince(team, pull, now)))
      if (answeredSince(pull, since)) return undefined
      return row(pull, 'needs', `via ${teams.map((team) => pullHandle(team.login)).join(', ')}`, since)
    }
    const assigned = parseIso(pull.viewerAssignedAt)
    if (assigned !== undefined)
      return answeredSince(pull, assigned) ? undefined : row(pull, 'needs', 'Assigned', assigned)
    return row(pull, 'needs', 'Requested', readySince(pull, now))
  }

  function waitingRow(pull, wait, since) {
    const [only] = wait.holders
    const soleTeam = wait.holders.length === 1 && only.kind === 'team' ? only.person : undefined
    const reason = soleTeam === undefined ? 'Waiting' : `via ${pullHandle(soleTeam)}`
    const waitingOn = wait.holders.flatMap((holder) => (holder.person === undefined ? [] : [holder.person]))
    return row(pull, 'waiting', reason, since, waitingOn)
  }

  function authoredRow(pull, now) {
    const updated = parseIso(pull.updatedAt) ?? now
    if (pull.draft) return row(pull, 'drafts', 'Draft', updated)
    if (pull.checks === 'failing') return row(pull, 'needs', 'CI failing', parseIso(pull.headCommittedAt) ?? updated)
    const wait = deriveOpenHolders(pull, now)
    const since = Math.min(...wait.holders.map((holder) => holder.since))
    if (wait.status === 'review') return waitingRow(pull, wait, since)
    return row(pull, 'needs', NEEDS_REASON[wait.status], since)
  }

  const uniqueOpen = (pulls) =>
    pulls.filter(
      (pull, index) => pull.state === 'open' && pulls.findIndex((other) => other.number === pull.number) === index,
    )

  /**
   * One row per open pull request, with `role` saying whose move it is from: `author` for the
   * viewer's own pull requests, `reviewer` for asks from others. Inbound asks and own pull requests whose ball came back under
   * `needs`, those held by others under `waiting`, drafts under `drafts`. Needs and waiting list
   * the oldest ask first; drafts the newest.
   */
  function pullWaitRows(snapshot, now) {
    const authored = uniqueOpen(snapshot.authored)
    const own = new Set(authored.map((pull) => pull.number))
    const inbound = uniqueOpen(snapshot.reviewRequested).filter(
      (pull) => pull.author !== snapshot.viewer && !own.has(pull.number),
    )
    const rows = [
      ...inbound.flatMap((pull) => inboundRow(pull, snapshot.viewer, now) ?? []).map((item) => ({ ...item, role: 'reviewer' })),
      ...authored.map((pull) => ({ ...authoredRow(pull, now), role: 'author' })),
    ]
    const ofList = (list) => rows.filter((item) => item.list === list)
    return [
      ...ofList('needs').sort((a, b) => a.since - b.since),
      ...ofList('waiting').sort((a, b) => a.since - b.since),
      ...ofList('drafts').sort((a, b) => b.since - a.since),
    ]
  }

  const api = Object.freeze({ pullWaitRows, pullHandle })
  if (typeof module === 'object') module.exports = api
  else window.pullWaits = api
})()
