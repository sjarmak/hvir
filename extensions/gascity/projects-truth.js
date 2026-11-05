;(() => {
  const HER = 'stephanie'
  const NO_WAITS = 'none'
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
  const tokens = (project) => meta(project, 'proj.waiting_on').toLowerCase().split(SPLIT).filter(Boolean)
  const named = (project) => tokens(project).filter((token) => token !== NO_WAITS)
  const mixesNone = (project) => tokens(project).includes(NO_WAITS) && tokens(project).length > 1
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
    if (token === HER) return { id: HER, kind: 'her', open: true, owner: HER, until: '' }
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

  const filled = (bead, key) => meta(bead, key).trim()
  const hasStarted = (bead) => OPEN.has(bead.status) && !isAsk(bead) && !filled(bead, 'receipt.delivered_at') &&
    (bead.status === 'in_progress' || filled(bead, 'receipt.started_at').length > 0)

  const startedWork = (linked, inProgress) => {
    const seen = new Map()
    for (const bead of [...inProgress, ...linked].filter(hasStarted)) {
      const key = `${bead.store ?? ''}#${bead.id}`
      if (!seen.has(key)) seen.set(key, bead)
    }
    return [...seen.values()]
  }

  const checkpoint = (milestone, due) => milestone || due
    ? `next ${[milestone || 'checkpoint', due && `by ${due}`].filter(Boolean).join(' ')}`
    : 'no next checkpoint'

  const label = (bead) => bead.title || bead.id

  const startEvidence = (bead) => [
    label(bead),
    filled(bead, 'receipt.owner') || bead.assignee || 'owner not recorded',
    filled(bead, 'receipt.started_at') ? `started ${filled(bead, 'receipt.started_at')}` : 'claimed in progress',
    filled(bead, 'receipt.artifact') && `artifact ${filled(bead, 'receipt.artifact')}`,
    checkpoint(filled(bead, 'receipt.milestone'), filled(bead, 'receipt.due')),
  ].filter(Boolean).join(' · ')

  const askEvidence = (bead) => [label(bead),
    filled(bead, 'gc.scope') ? `scope ${filled(bead, 'gc.scope')}` : 'no scope recorded',
    filled(bead, 'gc.recommendation') ? `recommend ${filled(bead, 'gc.recommendation')}` : 'no recommendation recorded',
  ].join(' · ')

  const owedEvidence = (bead) => [label(bead),
    `answered ${filled(bead, 'gc.answered_at') || filled(bead, 'gc.answered')}`,
    filled(bead, 'gc.delivery_bead') || filled(bead, 'gc.work_bead')
      ? `delivered by ${filled(bead, 'gc.delivery_bead') || filled(bead, 'gc.work_bead')}` : 'no delivery task named',
    filled(bead, 'gc.owner') || 'owner not recorded',
    filled(bead, 'gc.readout_due') ? `next ${filled(bead, 'gc.readout_due')}` : 'no next checkpoint',
  ].join(' · ')

  const stateEvidence = (state, { pending, started, owed, project }) => {
    if (state === 'needs-you') return pending.map(askEvidence)
    if (state === 'moving') return started.map(startEvidence)
    if (state === 'agents-owe') return owed.map(owedEvidence)
    if (state === 'done') return [filled(project, 'proj.receipt_at')
      ? `delivered · receipt ${filled(project, 'proj.receipt_at')}` : 'delivered · no delivery receipt recorded']
    return []
  }

  const derivedState = (claimed, pending, owed, waits, linked, started, complete) => {
    const open = linked.filter((bead) => OPEN.has(bead.status) && !isAsk(bead))
    if (pending.length) return 'needs-you'
    if (started.length) return 'moving'
    if (owed.length) return 'agents-owe'
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

  const checks = ({ claimed, pending, waits, milestones, declared, mixed, complete }) => {
    if (claimed === 'done') return []
    const overdue = milestones.filter((entry) => entry.overdue)
      .map((entry) => `Milestone ${entry.id} is ${entry.state} and its due date ${entry.target} has passed`)
    if (!complete) return [...overdue, UNREAD]
    return [
      ...overdue,
      declared && ['paused', 'stuck'].includes(claimed) && !waits.length && `Says ${claimed} but names nothing it waits on`,
      declared && mixed && 'Names none together with other waits',
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

  const truth = ({ project, linkedBeads, inProgress = [], milestones, now, complete = true }) => {
    const today = (now ?? '').slice(0, 10)
    const claimed = meta(project, 'proj.state') || 'unknown'
    const linked = linkedTo(project, linkedBeads)
    const pending = linked.filter(waitsOnHer)
    const owed = linked.filter(inDelivery)
    const started = startedWork(linked, inProgress)
    const waits = named(project).map((token) => wait(token, linked))
      .map((entry) => entry.kind === 'her' ? { ...entry, open: pending.length > 0 } : entry)
    const declared = names(project)
    const dated = milestones.map((entry) => ({ ...entry,
      overdue: ['planned', 'active'].includes(entry.state) && /^\d{4}-\d{2}-\d{2}$/.test(entry.target) && entry.target < today }))
    const next = dated.find((entry) => entry.id === meta(project, 'proj.next_milestone'))
    const verifiedAt = meta(project, 'proj.receipt_at') || null
    const state = derivedState(claimed, pending, owed, waits, linked, started, complete)
    return {
      claimedState: claimed,
      derivedState: state,
      stateEvidence: stateEvidence(state, { pending, started, owed, project }),
      needsCount: pending.length,
      waitingOn: waits,
      waitsVerified: declared && complete,
      waitsUnread: !complete,
      actionOwner: actionOwner(pending, waits, meta(project, 'proj.lead') || 'Unknown lead'),
      milestoneList: dated,
      next: next ?? null,
      checks: checks({ claimed, pending, waits, milestones: dated, declared, mixed: mixesNone(project), complete }),
      fetchedAt: now,
      verifiedAt,
      dates: dates({ next, waits, verifiedAt, fetchedAt: now }),
    }
  }

  const api = Object.freeze({ HER, REMOVED, UNREAD, waitsOnHer, inDelivery, undated, truth })
  if (typeof module === 'object') module.exports = api
  else window.projectsTruth = api
})()
