;(() => {
  const HER = 'stephanie'
  const DOT = 'pip'
  const NEEDS_LABEL = 'needs/stephanie'
  const LINK_KEYS = ['proj.id', 'gc.project']
  const SPLIT = /[\s,;+()]+/
  const ZONE = '(?:Z|\\s?(?:UTC|GMT))'
  const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|' +
    'Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?'
  const DATE = new RegExp([
    `(?<![\\w-])\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:${ZONE}|[+-]\\d{2}:?\\d{2})?)?(?:\\s(?:UTC|GMT))?(?![\\w-])`,
    `(?<![\\w:-])\\d{1,2}:\\d{2}(?::\\d{2})?${ZONE}(?![\\w-])`,
    `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`,
    `\\b${MONTH}\\s+\\d{4}\\b`,
  ].join('|'), 'g')
  const REMOVED = '[date removed]'
  const OPEN = new Set(['open', 'in_progress', 'blocked', 'deferred', 'hooked'])

  const meta = (bead, key) => {
    const value = bead?.metadata?.[key]
    return value === undefined || value === null ? '' : String(value)
  }
  const names = (project) => project?.metadata?.['proj.waiting_on'] !== undefined
  const isAsk = (bead) => (bead.labels ?? []).some((label) => label.toLowerCase() === NEEDS_LABEL)
  const answered = (bead) => meta(bead, 'gc.answered').length > 0
  const waitsOnHer = (bead) => bead.status === 'open' && isAsk(bead) &&
    (!answered(bead) || meta(bead, 'gc.waiting_on') === HER)
  const inDelivery = (bead) => bead.status === 'open' && isAsk(bead) && answered(bead) && !waitsOnHer(bead)
  const undated = (value) => String(value ?? '').replace(DATE, REMOVED)
  const named = (project) => meta(project, 'proj.waiting_on').split(SPLIT).filter(Boolean)
  const owner = (bead) => bead.assignee || meta(bead, 'gc.waiting_on') || meta(bead, 'gc.owner') ||
    meta(bead, 'gc.routed_to') || ''

  const linkedTo = (project, beads) => {
    const seen = new Map()
    for (const bead of beads) {
      if (!LINK_KEYS.some((key) => meta(bead, key) === project.id)) continue
      seen.set(`${bead.store ?? ''}#${bead.id}`, bead)
    }
    return [...seen.values()]
  }

  const wait = (token, linked) => {
    if (token.toLowerCase() === HER) return { id: HER, kind: 'her', open: true, owner: HER, until: '' }
    const bead = linked.find((entry) => entry.id === token)
    if (!bead) return { id: token, kind: 'not-linked', open: false, owner: '', until: '' }
    const until = meta(bead, 'gc.paused_until') || bead.defer_until || ''
    const kind = isAsk(bead) ? (waitsOnHer(bead) ? 'her-decision' : 'decision-in-delivery') : 'work'
    return { id: token, kind, status: bead.status, open: OPEN.has(bead.status), owner: owner(bead), until }
  }

  const actionOwner = (pending, waits, lead) => {
    if (pending.length) return { kind: 'user', name: 'Stephanie' }
    if (waits.some((entry) => entry.open && entry.owner.toLowerCase() === DOT)) return { kind: 'dot', name: 'Pip' }
    const agent = waits.find((entry) => entry.open && entry.owner && entry.owner.toLowerCase() !== HER)
    return { kind: 'agent', name: agent?.owner || lead }
  }

  const derivedState = (claimed, pending, waits, linked, running, complete) => {
    const open = linked.filter((bead) => OPEN.has(bead.status) && !isAsk(bead))
    if (pending.length) return 'needs-you'
    if (running) return 'moving'
    if (!complete) return 'unread'
    if (waits.some((entry) => entry.open)) return 'waiting'
    if (open.some((bead) => ['blocked', 'deferred'].includes(bead.status))) return 'waiting'
    if (open.length) return 'queued'
    return claimed === 'done' ? 'done' : 'no-linked-work'
  }

  const waitChecks = (waits) => waits.flatMap((entry) => {
    if (entry.kind === 'not-linked') return [`${entry.id} is named as a wait but is closed or not linked to this project`]
    if (entry.kind !== 'her' && !entry.open) return [`${entry.id} is named as a wait but is ${entry.status}`]
    if (entry.kind === 'decision-in-delivery') return [`${entry.id} is answered with no step of hers left; name the work that delivers it`]
    return []
  })

  const UNREAD = 'Linked work or decisions could not be read; waits are not checked'

  const waitsNamed = ({ claimed, pending, waits }) => {
    const ids = new Set(waits.map((entry) => entry.id))
    return [
      claimed === 'needs-you' && !pending.some((bead) => ids.has(bead.id)) && 'Says it needs you but names no decision of hers',
      ...pending.filter((bead) => !ids.has(bead.id)).map((bead) => `${bead.id} waits on Stephanie but the card does not name it`),
      ...waitChecks(waits),
    ]
  }

  const checks = ({ claimed, pending, waits, milestones, declared, complete }) => {
    if (claimed === 'done') return []
    const overdue = milestones.filter((entry) => entry.overdue)
      .map((entry) => `Milestone ${entry.id} is ${entry.state} and its due date ${entry.target} has passed`)
    if (!complete) return [...overdue, UNREAD]
    return [
      ...overdue,
      declared && ['paused', 'stuck'].includes(claimed) && !waits.length && `Says ${claimed} but names nothing it waits on`,
      waits.some((entry) => entry.kind === 'her') && !pending.length && 'Says it waits on Stephanie but no decision of hers is linked',
      !declared && claimed === 'needs-you' && !pending.length && 'Says it needs you but no decision of hers is open',
      ...(declared ? waitsNamed({ claimed, pending, waits }) : []),
    ].filter(Boolean)
  }

  const dates = ({ next, waits, verifiedAt, fetchedAt }) => [
    next?.target && { label: `Due: ${next.title}`, at: next.target, reason: 'deadline', overdue: next.overdue },
    ...waits.filter((entry) => entry.until)
      .map((entry) => ({ label: `Waits until: ${entry.id}`, at: entry.until, reason: 'dependency', overdue: false })),
    { label: 'Last verified progress', at: verifiedAt ?? '', reason: 'evidence-check', overdue: false },
    { label: 'Fetched', at: fetchedAt, reason: 'evidence-check', overdue: false },
  ].filter(Boolean)

  const truth = ({ project, linkedBeads, milestones, running, now, complete = true }) => {
    const today = (now ?? '').slice(0, 10)
    const claimed = meta(project, 'proj.state') || 'unknown'
    const linked = linkedTo(project, linkedBeads)
    const pending = linked.filter(waitsOnHer)
    const waits = named(project).map((token) => wait(token, linked))
      .map((entry) => entry.kind === 'her' ? { ...entry, open: pending.length > 0 } : entry)
    const declared = names(project)
    const dated = milestones.map((entry) => ({ ...entry,
      overdue: ['planned', 'active'].includes(entry.state) && /^\d{4}-\d{2}-\d{2}$/.test(entry.target) && entry.target < today }))
    const next = dated.find((entry) => entry.id === meta(project, 'proj.next_milestone'))
    const verifiedAt = meta(project, 'proj.receipt_at') || null
    return {
      claimedState: claimed,
      derivedState: derivedState(claimed, pending, waits, linked, running, complete),
      needsCount: pending.length,
      waitingOn: waits,
      waitsVerified: declared && complete,
      waitsUnread: !complete,
      actionOwner: actionOwner(pending, waits, meta(project, 'proj.lead') || 'Unknown lead'),
      milestoneList: dated,
      next: next ?? null,
      checks: checks({ claimed, pending, waits, milestones: dated, declared, complete }),
      fetchedAt: now,
      verifiedAt,
      dates: dates({ next, waits, verifiedAt, fetchedAt: now }),
    }
  }

  const api = Object.freeze({ HER, REMOVED, UNREAD, waitsOnHer, inDelivery, undated, truth })
  if (typeof module === 'object') module.exports = api
  else window.projectsTruth = api
})()
