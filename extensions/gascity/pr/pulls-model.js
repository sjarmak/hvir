/* global window, module, require */
;(() => {
  const node = typeof module === 'object'
  const { pullWaitRows } = node ? require('./pull-waits.js') : window.pullWaits
  const { pullStacks } = node ? require('./pull-stacks.js') : window.pullStacks
  const { BUSINESS_DAY_MS, businessMsBetween, formatBusinessAge, businessAgeTone } = node
    ? require('./business-time.js')
    : window.businessTime

  const SECTIONS = [
    ['branch', 'This branch'],
    ['ready', 'PRs ready for review'],
    ['review', 'PRs in review'],
    ['drafts', 'Draft PRs'],
    ['requested', 'Reviews requested'],
    ['aside', 'Set aside until they change'],
    ['issues', 'Assigned issues'],
  ]
  const CHECK_BADGES = {
    passing: { label: 'CI passing', tone: 'success' },
    failing: { label: 'CI failing', tone: 'danger' },
    pending: { label: 'CI running', tone: 'neutral' },
  }
  const REVIEW_BADGES = {
    approved: { label: 'Approved', tone: 'success' },
    'changes-requested': { label: 'Changes requested', tone: 'danger' },
    'review-required': { label: 'Review required', tone: 'neutral' },
  }
  const REASON_TONES = { 'Ready to merge': 'success', 'Changes requested': 'danger', 'CI failing': 'danger' }
  const RESTATED_BY_REASON = { 'ready to merge': 'approved' }
  const SECTION_REASONS = { ready: ['No reviewer yet'], review: ['Waiting'] }
  const ACTIVITY_TONES = { approved: 'success', changes: 'danger', commented: 'neutral' }

  /** Whose pull request a row is; `other` (someone else's branch, no ask) shows the author instead. */
  const ROLE_LABELS = { author: 'Yours', reviewer: 'Reviewer', assignee: 'Assigned', other: '' }
  const roleLabel = (row) => ROLE_LABELS[row.role]

  function parseIso(value) {
    const ms = Date.parse(value ?? '')
    return Number.isNaN(ms) ? undefined : ms
  }

  const activityAt = (item) => parseIso(item.updatedAt) ?? 0

  function issueRows(snapshot, now) {
    const open = (snapshot.issues ?? []).filter(
      (issue, index, all) =>
        issue.state === 'open' && all.findIndex((other) => other.number === issue.number) === index,
    )
    return open
      .map((issue) => ({
        issue,
        reason: '',
        since: parseIso(issue.viewerAssignedAt) ?? parseIso(issue.createdAt) ?? now,
        waitingOn: [],
        role: 'assignee',
      }))
      .sort((a, b) => activityAt(b.issue) - activityAt(a.issue))
  }

  const byOpenThenNewest = (left, right) =>
    Number(right.state === 'open') - Number(left.state === 'open') || right.updatedAt.localeCompare(left.updatedAt)

  function byActivityKeepingStacks(rows) {
    const groups = new Map()
    for (const row of rows) {
      const key = row.stack ? `stack-${row.stack.id}` : `pull-${row.pull.number}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    return [...groups.values()]
      .map((members) => ({
        members: [...members].sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0)),
        latest: Math.max(...members.map((row) => activityAt(row.pull))),
      }))
      .sort((a, b) => b.latest - a.latest)
      .flatMap((group) => group.members)
  }

  const inReview = (pull) => pull.reviewers.length > 0 || pull.reviewedByOthers === true

  function authoredSection(row) {
    if (row.pull.draft) return 'drafts'
    return inReview(row.pull) ? 'review' : 'ready'
  }

  const isAside = (pull, aside) => aside[pull.number] !== undefined && aside[pull.number] === pull.updatedAt

  function sectionOf(row, aside) {
    if (row.role !== 'reviewer') return authoredSection(row)
    return isAside(row.pull, aside) ? 'aside' : 'requested'
  }

  function withoutSectionReason(row, key) {
    return (SECTION_REASONS[key] ?? []).includes(row.reason) ? { ...row, reason: '' } : row
  }

  function pullSections(snapshot, now, aside = {}) {
    const stacks = pullStacks([...snapshot.branchPulls, ...snapshot.authored, ...snapshot.reviewRequested], snapshot.repo)
    const withStack = (row) => ({ ...row, stack: stacks.get(row.pull.number) })
    const waits = pullWaitRows(snapshot, now).map(withStack)
    const branch = snapshot.branchPulls
      .filter((pull, index, all) => all.findIndex((other) => other.number === pull.number) === index)
      .sort(byOpenThenNewest)
    const shown = new Set(branch.map((pull) => pull.number))
    const branchRows = branch.map(
      (pull) =>
        waits.find((wait) => wait.pull.number === pull.number) ??
        withStack({
          pull,
          reason: '',
          waitingOn: [],
          role: pull.author === snapshot.viewer ? 'author' : 'other',
        }),
    )
    const rowsOf = (key) => {
      if (key === 'branch') return branchRows
      if (key === 'issues') return issueRows(snapshot, now)
      const rows = waits
        .filter((row) => !shown.has(row.pull.number) && sectionOf(row, aside) === key)
        .map((row) => withoutSectionReason(row, key))
      return byActivityKeepingStacks(rows)
    }
    return SECTIONS.map(([key, label]) => ({ key, label, rows: rowsOf(key) }))
  }

  /**
   * The header count: distinct pull requests (by URL) that need the viewer across snapshots. A
   * branch pull request that needs the viewer counts even though the panel lists it under This branch.
   */
  function needYouCount(snapshots, now) {
    const urls = new Set(
      snapshots.flatMap((snapshot) =>
        pullWaitRows(snapshot, now).flatMap((row) => (row.list === 'needs' ? [row.pull.url] : [])),
      ),
    )
    return urls.size
  }

  function age(since, now) {
    const ms = businessMsBetween(since, now)
    return { label: formatBusinessAge(ms), tone: businessAgeTone(ms) }
  }

  const reasonTone = (reason) => REASON_TONES[reason] ?? 'neutral'

  function reviewBadge(pull) {
    if (pull.review !== 'none') return REVIEW_BADGES[pull.review]
    return pull.reviewers.some((reviewer) => reviewer.reviewState === 'approved') ? REVIEW_BADGES.approved : undefined
  }

  function badges({ pull, reason }) {
    const items = [
      pull.state !== 'open' ? { label: pull.state, tone: 'neutral' } : undefined,
      pull.draft ? { label: 'Draft', tone: 'neutral' } : undefined,
      CHECK_BADGES[pull.checks],
      reviewBadge(pull),
      pull.openFeedback > 0
        ? {
            label: `${pull.openFeedback} open ${pull.openFeedback === 1 ? 'comment' : 'comments'}`,
            tone: 'warning',
          }
        : undefined,
    ]
    const restated = [reason.toLowerCase(), RESTATED_BY_REASON[reason.toLowerCase()]]
    return items.filter((item) => item !== undefined && !restated.includes(item.label.toLowerCase()))
  }

  function activitySignal(pull, now) {
    const event = pull.activity
    const at = parseIso(event?.at)
    if (event === undefined || at === undefined) return undefined
    const verb = { approved: 'approved', changes: 'requested changes', commented: 'commented' }[event.kind]
    return {
      label: `@${event.by} ${verb}`,
      at,
      tone: ACTIVITY_TONES[event.kind],
      fresh: businessMsBetween(at, now) < BUSINESS_DAY_MS,
      newCount: pull.newSinceViewer ?? 0,
    }
  }

  function stackSummary(stack) {
    if (stack === undefined) return undefined
    const size = stack.order.length
    const label = stack.parent === undefined ? `Stack base · ${size} PRs` : `Stack ${stack.position + 1}/${size} · on #${stack.parent}`
    return { label, order: stack.order, id: stack.id, depth: stack.depth }
  }

  function withAside(aside, pull, setAside) {
    const rest = Object.fromEntries(Object.entries(aside).filter(([number]) => number !== String(pull.number)))
    return setAside ? { ...rest, [pull.number]: pull.updatedAt } : rest
  }

  function pruneAside(aside, pulls) {
    const current = new Map(pulls.map((pull) => [String(pull.number), pull.updatedAt]))
    return Object.fromEntries(Object.entries(aside).filter(([number, at]) => !current.has(number) || current.get(number) === at))
  }

  function reviewProgressLabel(progress, pull) {
    if (progress === undefined) return undefined
    const read = Object.keys(progress.read).length
    const parts = [
      read > 0 ? `reviewed ${Math.min(read, pull.changedFiles ?? read)}/${pull.changedFiles ?? '?'} files` : '',
      progress.drafts > 0 ? `${progress.drafts} draft ${progress.drafts === 1 ? 'comment' : 'comments'}` : '',
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : undefined
  }

  const api = Object.freeze({
    pullSections,
    isAside,
    withAside,
    pruneAside,
    reviewProgressLabel,
    issueRows,
    needYouCount,
    age,
    badges,
    reasonTone,
    activitySignal,
    stackSummary,
    roleLabel,
  })
  if (node) module.exports = api
  else window.pullsModel = api
})()
