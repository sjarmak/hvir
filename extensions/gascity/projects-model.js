;(() => {
  const truthApi = typeof module === 'object' ? require('./projects-truth.js') : window.projectsTruth
  const needsApi = typeof module === 'object' ? require('./needs-model.js') : window.needsModel
  const meta = (bead, key) => bead?.metadata?.[key] ?? ''
  const tierLabel = (bead) => {
    const raw = bead?.metadata?.['gc.tier']
    if (raw === undefined || raw === null || String(raw).trim() === '') return ''
    const value = String(raw).trim()
    return typeof raw !== 'boolean' && ['1', '2', '3'].includes(value) ? `Tier ${value}` : `Tier ${value} is not 1-3`
  }
  const identity = (bead) => bead ? { id: bead.id, title: bead.title,
    ...(bead.store === undefined ? {} : { store: bead.store }) } : null
  const tokens = (value) => value ? value.split(',') : []

  const parseRefs = (value) => {
    const refs = []
    const invalid = []
    if (value === undefined || value === null || value === '') return { refs, invalid }
    if (typeof value !== 'string') return { refs, invalid: [value] }
    for (const key of value.split(',')) {
      const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(key)
      if (!match || match[0] !== key) invalid.push(key)
      else refs.push({ owner: match[1], repo: match[2], number: Number(match[3]), key })
    }
    return { refs, invalid }
  }

  const references = (beads, states) => {
    const result = { prs: [], issues: [], invalid: [] }
    for (const field of ['prs', 'issues']) {
      const seen = new Set()
      for (const bead of beads) {
        const parsed = parseRefs(meta(bead, `ref.${field}`))
        result.invalid.push(...parsed.invalid)
        for (const ref of parsed.refs) {
          if (seen.has(ref.key)) continue
          seen.add(ref.key)
          result[field].push({ ...states[ref.key], ...ref })
        }
      }
    }
    return result
  }

  const parents = (bead) => [...new Set([
    bead?.parent,
    ...(bead?.dependencies ?? [])
      .filter((dependency) => (dependency.type ?? dependency.dependency_type) === 'parent-child')
      .map((dependency) => dependency.depends_on_id ?? dependency.id),
  ].filter(Boolean))]

  const workflowRoot = (bead, index) => {
    const root = index.get(meta(bead, 'gc.root_bead_id'))
    return meta(root, 'gc.kind') === 'workflow' ? root : null
  }

  const resolveProject = (bead, index, projects) => {
    const root = workflowRoot(bead, index)
    const direct = meta(bead, 'proj.id') || meta(root, 'proj.id')
    if (direct) return projects.get(direct) ?? null
    const pending = [bead, root].filter(Boolean)
    const seen = new Set()
    while (pending.length) {
      const current = pending.shift()
      if (seen.has(current.id)) continue
      seen.add(current.id)
      if (projects.has(current.id)) return projects.get(current.id)
      const linked = meta(current, 'proj.id')
      if (linked) return projects.get(linked) ?? null
      pending.push(...parents(current).map((id) => index.get(id)).filter(Boolean))
    }
    return null
  }

  const workflow = (root, step, steps) => {
    const children = steps.filter((bead) => meta(bead, 'gc.root_bead_id') === root.id)
    return {
      rootId: root.id,
      formula: meta(root, 'gc.formula_name'),
      step: meta(step, 'gc.step_id'),
      stepsDone: children.filter((bead) => bead.status === 'closed').length,
      stepsTotal: children.length,
    }
  }

  const modelName = (command, provider) => {
    if (Array.isArray(command)) {
      const position = command.indexOf('--model')
      return (position >= 0 ? command[position + 1] : null) || provider || ''
    }
    const match = /(?:^|\s)--model\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command ?? '')
    return match ? match[1] ?? match[2] ?? match[3] : provider || ''
  }

  const identities = (session) => [session.id, session.name, session.agent_name, session.alias].filter(Boolean)
  const beadKey = (bead) => `${bead.store ?? ''}#${bead.id}`
  const LIST_CAP = 20
  const capRows = (rows) => ({ rows: rows.slice(0, LIST_CAP), more: Math.max(0, rows.length - LIST_CAP) })
  const DEC_ID = /^dec-[a-z0-9]+$/
  const isDecision = (bead) => truthApi.isAsk(bead) || DEC_ID.test(bead.id)

  const collectActivity = (input, index, projects) => {
    const entries = []
    const add = (source, bead, kind) => {
      const root = workflowRoot(bead, index)
      entries.push({
        project: identity(resolveProject(bead, index, projects)),
        item: {
          session: source.name,
          agent: source.agent_name ?? '',
          account: source.account ?? '',
          model: modelName(source.command, source.provider),
          startedAt: source.started_at ?? null,
          bead: identity(bead),
          workflow: root ? workflow(root, bead, input.workflowSteps ?? []) : null,
          kind,
        },
      })
    }
    const seen = new Set()
    for (const session of input.sessions ?? []) {
      const key = session.id ?? session.name
      if (seen.has(key)) continue
      seen.add(key)
      const assignees = identities(session)
      const beads = (input.inProgress ?? []).filter((entry) =>
        entry.status === 'in_progress' && assignees.includes(entry.assignee))
      for (const bead of beads.length ? beads : [undefined]) add(session, bead, 'session')
    }
    for (const { seat, label, job, alive } of input.seatJobs ?? []) {
      if (!alive || !job) continue
      add({ name: `${seat} / ${label}`, agent_name: seat, command: job.argv,
        provider: job.account, account: job.account, started_at: job.started_at }, index.get(job.bead), 'seat-job')
    }
    return entries
  }

  const flightRow = (item) => ({ who: item.session, bead: item.bead, startedAt: item.startedAt,
    model: item.model, working: true, claim: '' })

  const liveWorkers = (input) => new Set([
    ...(input.sessions ?? []).flatMap(identities),
    ...(input.seatJobs ?? []).filter((entry) => entry.alive && entry.job).map((entry) => entry.seat),
  ].filter(Boolean))

  const claimedIdle = (inProgress, active, input) => {
    const workers = liveWorkers(input)
    const covered = new Set(active.filter((item) => item.bead).map((item) => beadKey(item.bead)))
    const seatsRead = input.seatJobsRead === true || (input.seatJobs ?? []).length > 0
    const claim = seatsRead ? 'nobody working' : 'no live session'
    return inProgress
      .filter((bead) => bead.assignee && !covered.has(beadKey(bead)) && !workers.has(bead.assignee))
      .map((bead) => ({ who: bead.assignee, bead: identity(bead), startedAt: null, model: '', working: false, claim }))
  }

  const isRecord = (bead) => (bead.labels ?? []).some((label) => ['city-project', 'city-milestone', 'city-artifact'].includes(label)) ||
    meta(bead, 'gc.kind') === 'workflow'

  const isWorkflowStep = (bead) => Boolean(meta(bead, 'gc.root_bead_id') || meta(bead, 'gc.step_ref'))

  const queuedBeads = (input, index, projects, project, active) => {
    const decisions = new Set((input.decisions ?? []).map(beadKey))
    const flying = new Set(active.filter((item) => item.bead).map((item) => beadKey(item.bead)))
    return (input.linked ?? [])
      .filter((bead) => bead.status === 'open' && !isRecord(bead) && !isDecision(bead) && !truthApi.hasStarted(bead) &&
        !flying.has(beadKey(bead)) && !decisions.has(beadKey(bead)) && (resolveProject(bead, index, projects)?.id ?? meta(bead, 'gc.project')) === project.id)
      .map((bead) => ({ ...identity(bead), owner: bead.assignee ?? '', waitingOn: meta(bead, 'gc.waiting_on') }))
  }

  const flightLists = (active, inProgress, input) => {
    const all = [...active.filter((item) => item.bead).map(flightRow), ...claimedIdle(inProgress, active, input)]
    const { rows, more } = capRows(all)
    return { inFlight: rows, inFlightMore: more, inFlightTotal: all.length }
  }

  const queueLists = (all) => {
    const { rows, more } = capRows(all)
    return { queued: rows, queuedMore: more, queuedTotal: all.length }
  }

  const milestone = (bead, states) => ({
    ...identity(bead),
    target: meta(bead, 'ms.target'),
    targetReason: meta(bead, 'ms.target_reason'),
    state: meta(bead, 'ms.state') || 'unknown',
    projState: meta(bead, 'proj.state'),
    now: String(meta(bead, 'proj.now')),
    updatedAt: meta(bead, 'proj.updated_at') || null,
    outcome: meta(bead, 'ms.outcome'),
    refs: references([bead], states),
  })

  const ARTIFACT_STATES = ['tested', 'installed', 'live']
  const DAY_MS = 86400000

  const artifact = (bead, now, freshnessEnds) => {
    const closed = bead.status === 'closed'
    return {
      ...identity(bead),
      kind: meta(bead, 'art.kind'),
      ref: meta(bead, 'art.ref'),
      closed,
      states: ARTIFACT_STATES.map((name) => {
        const at = meta(bead, `art.${name}_at`)
        const source = meta(bead, `art.${name}_source`)
        const checkedAt = meta(bead, `art.${name}_checked_at`)
        const claimed = Boolean(at || source || checkedAt)
        const age = Date.parse(now) - Date.parse(checkedAt)
        return { name, claimed, at, source, checkedAt,
          stale: claimed && !closed && !freshnessEnds && age > DAY_MS }
      }),
    }
  }

  const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))

  const newest = (times) => times.filter(validTime).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null

  const childOf = (project) => (bead) => parents(bead).includes(project.id) && bead.store === project.store

  const projectWorkflows = (input, index, projects, project, active) =>
    (input.workflowRoots ?? [])
      .filter((root) => meta(root, 'gc.kind') === 'workflow' &&
        resolveProject(root, index, projects)?.id === project.id)
      .map((root) => ({
        ...workflow(root, null, input.workflowSteps ?? []),
        running: active.filter((item) => item.workflow?.rootId === root.id)
          .map((item) => ({ session: item.session, step: item.workflow.step })),
      }))

  const buildCard = (project, context) => {
    const { input, index, projects, needsYou, openDecisions, entries, states } = context
    const list = (input.milestones ?? []).filter(childOf(project))
      .map((bead) => milestone(bead, states))
      .sort((a, b) => a.target.localeCompare(b.target) || a.id.localeCompare(b.id))
    const active = entries.filter((entry) => entry.project?.id === project.id).map((entry) => entry.item)
    const decisions = openDecisions.filter((ask) => ask.project?.id === project.id)
    const state = meta(project, 'proj.state') || 'unknown'
    const updatedAt = meta(project, 'proj.updated_at') || null
    const complete = !(input.unread ?? []).some((field) => ['linked', 'decisions', 'inProgress'].includes(field))
    const inProgress = (input.inProgress ?? [])
      .filter((bead) => bead.status === 'in_progress' && resolveProject(bead, index, projects)?.id === project.id)
    const truth = truthApi.truth({ project, milestones: list, now: input.now, complete, inProgress,
      linkedBeads: [...(input.linked ?? []), ...(input.decisions ?? []), ...(input.inProgress ?? [])] })
    return {
      ...identity(project),
      lead: meta(project, 'proj.lead') || 'Unknown lead',
      contributors: tokens(meta(project, 'proj.contributors')),
      state,
      now: String(meta(project, 'proj.now')),
      stuckWhy: String(meta(project, 'proj.stuck_why')),
      blocker: String(meta(project, 'proj.blocker')),
      nextAction: String(meta(project, 'proj.next_action')),
      derivedState: truth.derivedState,
      stateEvidence: truth.stateEvidence,
      inDelivery: truth.inDelivery,
      inDeliveryItems: truth.inDeliveryItems,
      actionOwner: truth.actionOwner,
      waitingOn: truth.waitingOn,
      waitsVerified: truth.waitsVerified,
      waitsUnread: truth.waitsUnread,
      checks: truth.checks,
      fetchedAt: truth.fetchedAt,
      verifiedAt: truth.verifiedAt,
      dates: truth.dates,
      updatedAt,
      writtenAt: validTime(meta(project, 'proj.content_at')) ? meta(project, 'proj.content_at') : null,
      changedAt: newest([updatedAt, ...list.map((entry) => entry.updatedAt)]),
      stale: state !== 'done' && !(Date.parse(input.now) - Date.parse(updatedAt) <= DAY_MS),
      artifacts: (input.artifacts ?? []).filter(childOf(project))
        .map((bead) => artifact(bead, input.now, state === 'done')),
      milestones: {
        done: list.filter((entry) => entry.state === 'done').length,
        total: list.filter((entry) => entry.state !== 'dropped').length,
        next: truth.next ? { ...identity(truth.next), target: truth.next.target,
          targetReason: truth.next.targetReason, state: truth.next.state,
          overdue: truth.next.overdue } : null,
      },
      milestoneList: truth.milestoneList,
      needsCount: truth.needsCount,
      refs: references([project, ...(input.milestones ?? []).filter(childOf(project)), ...decisions], states),
      active,
      agentsActive: new Set(active.map((item) => item.session)).size,
      ...flightLists(active, inProgress, input),
      ...queueLists(queuedBeads(input, index, projects, project, active)),
      inProgress: inProgress.map((bead) => ({ ...identity(bead), assignee: bead.assignee ?? '' })),
      decisions,
      workflows: projectWorkflows(input, index, projects, project, active),
      outcomes: (input.outcomes ?? []).filter((entry) => entry.projects.includes(project.id)),
    }
  }

  const groupActivity = (entries) => {
    const groups = new Map()
    for (const { project, item } of entries) {
      const key = project?.id ?? null
      if (!groups.has(key)) groups.set(key, { project, label: project?.title ?? 'No project', items: [] })
      groups.get(key).items.push(item)
    }
    return [...groups.values()]
  }

  const sessionFor = (sessions, seat) =>
    seat ? (sessions ?? []).find((session) => session.alias === seat || session.name === seat || session.session_name === seat) : undefined

  const answerToOf = (bead) => {
    const owner = meta(bead, 'gc.owner')
    const value = typeof owner === 'string' && owner.trim() ? owner : bead.created_by
    return typeof value === 'string' ? value.trim() : ''
  }

  const withAnswerTo = (bead, sessions) => {
    const answerTo = answerToOf(bead)
    return answerTo ? { answerTo, answerLive: sessionFor(sessions, answerTo) !== undefined } : {}
  }

  const STUCK_CAP = 50

  const isSyntheticConvoy = (bead) => String(meta(bead, 'gc.synthetic')) === 'true'

  const trackedDependencies = (bead) => (bead.dependencies ?? [])
    .filter((dependency) => (dependency.type ?? dependency.dependency_type) === 'tracks')

  const unreadTracked = (convoy, dependency) => ({ ...convoy, id: dependency.depends_on_id ?? dependency.id,
    title: dependency.title ?? '', status: dependency.status ?? '', convoy: convoy.id })

  const folded = (bead, index) => {
    const tracks = isSyntheticConvoy(bead) ? trackedDependencies(bead) : []
    if (tracks.length !== 1 || !(tracks[0].depends_on_id ?? tracks[0].id)) return bead
    const tracked = index.get(tracks[0].depends_on_id ?? tracks[0].id)
    return tracked ? { ...tracked, store: tracked.store ?? bead.store, convoy: bead.id } : unreadTracked(bead, tracks[0])
  }

  const urgentBeads = (input, decisions, index) => {
    const known = new Set(decisions.map(beadKey))
    const seen = new Map()
    for (const bead of [...(input.urgent ?? []), ...(input.inProgress ?? []), ...(input.linked ?? [])]) {
      if (known.has(beadKey(bead)) || isRecord(bead) || isWorkflowStep(bead) || isDecision(bead)) continue
      if (!['open', 'in_progress'].includes(bead.status) || !(Number(bead.priority) <= 1)) continue
      if (bead.priority === null || bead.priority === '' || bead.priority === undefined) continue
      const shown = folded(bead, index)
      if (!seen.has(beadKey(shown))) seen.set(beadKey(shown), shown)
    }
    return [...seen.values()]
  }

  const namesHerFirst = (value) => value.toLowerCase().split(/[^\w-]/)[0] === truthApi.HER
  const hasStepLabel = (bead) => (bead.labels ?? []).some((label) => String(label).toLowerCase() === needsApi.STEP_LABEL)

  const ownerOf = (bead, context) => {
    if (bead.assignee) return { owner: bead.assignee, ownerFrom: 'assignee' }
    const project = resolveProject(bead, context.index, context.projects) ?? context.projects.get(meta(bead, 'gc.project'))
    const lead = String(meta(project, 'proj.lead')).trim()
    return lead ? { owner: lead, ownerFrom: 'project lead' } : { owner: '', ownerFrom: '' }
  }

  const unclaimedPool = (bead, waitingOn) =>
    !waitingOn && !bead.assignee ? String(meta(bead, 'gc.execution_routed_to')).trim() : ''

  const knownSeats = (input, index, projects) => new Set([...liveWorkers(input),
    ...[...projects.values()].map((project) => String(meta(project, 'proj.lead')).trim()),
    ...[...index.values()].map((bead) => bead.assignee)].filter(Boolean))

  const waitToken = (waitingOn) => (waitingOn.match(/[\w.-]+/)?.[0] ?? '').replace(/\.+$/, '')

  const waitKind = (row, context) => {
    const token = waitToken(row.waitingOn)
    if (row.waitsOnHer || row.waitingOn.toLowerCase().startsWith(truthApi.HER)) return 'her'
    if (DEC_ID.test(token)) return 'decision'
    if (row.unclaimedBy || context.index.get(token)?.assignee || context.seats.has(token)) return 'agent'
    return ''
  }

  const waitedOverDay = (row, now) => row.updatedAt !== null && Date.parse(now) - Date.parse(row.updatedAt) > DAY_MS

  const withBrokenWait = (context) => (row) => {
    const kind = waitKind(row, context)
    return { ...row, waitKind: kind, likelyBroken: Boolean(kind) && waitedOverDay(row, context.now) }
  }

  const urgentRow = (context) => (bead) => {
    const stepLabel = hasStepLabel(bead)
    const waitingOn = String(meta(bead, 'gc.waiting_on')).trim() || (stepLabel ? truthApi.HER : '')
    return withBrokenWait(context)({ ...identity(bead), state: bead.status ?? '', convoy: bead.convoy ?? '', ...ownerOf(bead, context),
      priority: Number(bead.priority), updatedAt: validTime(bead.updated_at) ? bead.updated_at : null,
      waitingOn, waitsOnHer: stepLabel || namesHerFirst(waitingOn), unclaimedBy: unclaimedPool(bead, waitingOn),
      cardText: needsApi.cardText(bead, context.texts), description: needsApi.descriptionOf(bead) })
  }

  const oldestFirst = (a, b) => (a.updatedAt === null) - (b.updatedAt === null) ||
    Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id)

  const capped = (rows) => ({ items: rows.slice(0, STUCK_CAP), more: Math.max(0, rows.length - STUCK_CAP) })

  const urgentLists = (input, decisions, context) => {
    const rows = urgentBeads(input, decisions, context.index).map(urgentRow(context)).sort(oldestFirst)
    const waiting = rows.filter((row) => row.waitingOn)
    return { stuck: capped(rows.filter((row) => !row.waitingOn)),
      waiting: capped([...waiting.filter((row) => row.waitsOnHer), ...waiting.filter((row) => !row.waitsOnHer)]) }
  }

  const buildDashboard = (input) => {
    const beads = ['ancestors', 'urgent', 'linked', 'workflowSteps', 'workflowRoots', 'inProgress', 'decisions', 'artifacts', 'milestones', 'projects']
      .flatMap((key) => input[key] ?? [])
    const index = new Map(beads.map((bead) => [bead.id, bead]))
    const projects = new Map((input.projects ?? []).map((bead) => [bead.id, bead]))
    const states = input.refStates ?? {}
    const cardTexts = needsApi.cardTextRecord(input.artifacts ?? [])
    const openDecisions = (input.decisions ?? []).filter((bead) => bead.status === 'open')
      .map((bead) => ({ ...bead, project: identity(projects.get(meta(bead, 'gc.project'))),
        refs: references([bead], states), needsYou: truthApi.waitsOnHer(bead), tier: tierLabel(bead),
        inDelivery: truthApi.inDelivery(bead), cardText: needsApi.cardText(bead, cardTexts.texts), ...withAnswerTo(bead, input.sessions) }))
    const needsYou = openDecisions.filter((bead) => bead.needsYou)
    const inDelivery = openDecisions.filter((bead) => bead.inDelivery)
    const entries = collectActivity(input, index, projects)
    const groups = new Map()
    for (const project of projects.values()) {
      const card = buildCard(project, { input, index, projects, needsYou, openDecisions, entries, states })
      if (!groups.has(card.lead)) groups.set(card.lead, { lead: card.lead, cards: [] })
      groups.get(card.lead).cards.push(card)
    }
    const stepBeads = new Map([...(input.herSteps ?? []), ...openDecisions].map((bead) => [`${bead.store}#${bead.id}`, bead]))
    const herSteps = needsApi.herSteps([...stepBeads.values()], cardTexts.texts)
    const stepsUnread = (input.unread ?? []).includes('herSteps')
    return { now: input.now, ...urgentLists(input, input.decisions ?? [], { index, projects, texts: cardTexts.texts,
      now: input.now, seats: knownSeats(input, index, projects) }), needsYou, inDelivery, herSteps, stepsUnread,
      cardTextsInvalid: cardTexts.invalid, cards: [...groups.values()], activeNow: groupActivity(entries),
      outcomesShown: Array.isArray(input.outcomes) }
  }

  const duplicateProjects = (projects = []) => {
    const stores = new Map()
    for (const bead of projects) stores.set(bead.id, new Set([...(stores.get(bead.id) ?? []), bead.store]))
    return [...stores].filter(([, found]) => found.size > 1).map(([id]) => id)
  }

  const api = Object.freeze({ parseRefs, buildDashboard, duplicateProjects, sessionFor })
  if (typeof module === 'object') module.exports = api
  else window.projectsModel = api
})()
