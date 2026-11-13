;(() => {
  const loader = window.projectsLoad

  const REFRESH_DEADLINE_MS = 60000

  const readStores = (workspace, requests, options) => Promise.all(requests.map(async (request) => {
    try {
      const value = await window.bdRead(workspace, request.args, options)
      if (!Array.isArray(value)) throw new Error('bd returned an unexpected JSON shape')
      return { ...request, value }
    } catch (error) {
      return { ...request, error: error.message, ...(error.reason ? { notRun: true } : {}) }
    }
  }))

  const NEEDS_KEYS = ['decisions', 'herSteps']

  const ageText = (since) => {
    const minutes = Math.floor((Date.now() - Date.parse(since)) / 60000)
    return minutes < 1 ? 'under a minute ago' : `${minutes} min ago`
  }

  const aboutNeeds = (error) => NEEDS_KEYS.some((key) => error.includes(`) ${key}: `))

  const needsFreshStale = (stale) => stale && { failedAt: stale.failedAt, readAt: stale.readAt }

  const withFreshNeeds = (previous, needs) => {
    const payload = { ...previous.payload, decisions: needs.decisions, herSteps: needs.herSteps,
      unread: previous.payload.unread.filter((field) => !NEEDS_KEYS.includes(field)) }
    return { ...previous, payload, model: window.projectsModel.buildDashboard(payload), complete: false,
      stale: needsFreshStale(previous.stale),
      deferred: false, answerable: needs.answerable, needs,
      errors: [...previous.errors.filter((error) => !aboutNeeds(error)), ...needs.errors] }
  }

  const partialFrom = (needs, sessions) => {
    const { payload } = loader.assemblePayload({ now: needs.readAt, reads: [], sessions })
    const base = { payload, model: window.projectsModel.buildDashboard(payload), errors: [], sessions, complete: false,
      deferred: true, partial: true }
    return withFreshNeeds(base, needs)
  }

  const isNeedsSection = (node) => node.tagName === 'SECTION' && node.querySelector('h2')?.textContent === 'Needs you'

  const markLoading = (root) => {
    for (const node of [...root.children]) {
      if (node.classList.contains('projects-back')) continue
      if (isNeedsSection(node)) node.querySelectorAll('.projects-tag').forEach((tag) => tag.remove())
      else {
        const heading = node.tagName === 'SECTION' ? node.querySelector('h2')?.textContent : undefined
        node.replaceWith(window.el('section', { className: 'projects-loading' },
          ...(heading ? [window.el('h2', {}, heading)] : []), window.el('p', { className: 'hvir-meta' }, 'Loading…')))
      }
    }
  }

  const deferredNote = (shown, reason, needs) => needs
    ? `Needs you read ${ageText(needs.readAt)}; other sections from ${ageText(shown.payload.now)}: ${reason}`
    : `showing data from ${ageText(shown.payload.now)}: ${reason}`

  const readCity = async (workspace, { args, parse, connector = 'gc', field }, failures, options) => {
    try {
      return parse(await window.host.run(connector, workspace, args, options))
    } catch (error) {
      if (error.reason) failures.notRun = true
      if (field) failures.unread.push(field)
      failures.errors.push(`${connector} ${args.slice(0, 2).join(' ')}: ${error.message}`)
      return connector === 'gc' ? [] : undefined
    }
  }

  const read = async (workspace, { onNeeds, lastGood } = {}) => {
    const deadline = Date.now() + REFRESH_DEADLINE_MS
    const connectors = await window.host.availability({ workspace })
    const missing = ['gc', 'bd'].find((name) => connectors[name] !== 'supported')
    if (missing) return { missing }
    const failures = { errors: [], notRun: false, unread: [] }
    const { errors } = failures
    const [city, sessions] = await Promise.all([
      readCity(workspace, { args: ['rig', 'list', '--json'], parse: window.crewParse.parseRigList }, failures),
      readCity(workspace, { args: ['session', 'list', '--json'], parse: loader.liveSessions, field: 'sessions' }, failures),
    ])
    const stores = loader.storesFor(workspace, Array.isArray(city) ? {} : city)
    const requests = loader.storeRequests(stores)
    const isNeeds = (request) => NEEDS_KEYS.includes(request.key)
    const answerable = connectors[window.answerAction.CONNECTOR] === 'supported'
    const needsReads = await readStores(workspace, requests.filter(isNeeds))
    const needsFresh = needsReads.some((entry) => entry.key === 'decisions') && needsReads.every((entry) => !entry.error)
    let needs
    if (needsFresh) {
      const { payload, errors: needsErrors } = loader.assemblePayload({ now: new Date(Date.now()).toISOString(), reads: needsReads })
      needs = { readAt: payload.now, decisions: payload.decisions, herSteps: payload.herSteps, errors: needsErrors, answerable }
      await onNeeds?.(needs, sessions)
    }
    const options = { deadline }
    const otherReads = await readStores(workspace, requests.filter((request) => !isNeeds(request)), options)
    const reads = loader.splitLabeled([...needsReads, ...otherReads])
    reads.push(...await readStores(workspace, loader.workflowRequests(reads), options))
    for (let round = 0; round < loader.ANCESTOR_ROUNDS; round += 1) {
      const requests = loader.ancestorRequests(reads)
      if (!requests.length) break
      reads.push(...await readStores(workspace, requests, options))
    }
    if (loader.ancestorRequests(reads).length)
      errors.push(`parent chains deeper than ${loader.ANCESTOR_ROUNDS} unread levels were not followed`)
    const outcomes = connectors[loader.OUTCOME_CONNECTOR] === 'supported'
      ? await readCity(workspace, { args: [...loader.OUTCOME_ARGS], parse: loader.parseOutcomes,
        connector: loader.OUTCOME_CONNECTOR, field: 'outcomes' }, failures, options)
      : undefined
    const result = loader.assemblePayload({ now: new Date(Date.now()).toISOString(), reads, sessions, errors })
    const { payload, lastGood: kept, stale } = loader.keepLastGood({ lastGood, payload: { ...result.payload,
      ...(outcomes ? { outcomes } : {}), unread: [...result.payload.unread, ...failures.unread] } })
    const conflicts = window.projectsModel.duplicateProjects(payload.projects)
    if (conflicts.length) result.errors.push(`project id in several stores: ${conflicts.join(', ')}`)
    const projectsRead = reads.some((entry) => entry.key === 'projects' && !entry.error)
    const deferred = failures.notRun || reads.some((entry) => entry.notRun) ||
      !projectsRead
    const decisionReads = reads.filter((entry) => entry.key === 'decisions')
    const complete = !deferred && !failures.errors.length && decisionReads.length > 0 && decisionReads.every((entry) => !entry.error)
    return { answerable, complete, model: window.projectsModel.buildDashboard(payload), payload, errors: result.errors,
      sessions: payload.sessions, deferred, projectsRead, needs, lastGood: kept, stale }
  }

  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  const staleLine = (stale) => window.el('p', { className: 'projects-warning projects-stale' }, loader.staleText(stale))

  const statusLine = (data, workspace, withCounts = true) => {
    const { model, payload, errors, sessions } = data
    const time = clock(payload.now)
    const needsTime = data.needs ? clock(data.needs.readAt) : time
    const needsRead = needsTime === time ? '' : ` · Needs you read ${needsTime}`
    const counts = withCounts ? [`${model.needsYou.length} need you`, `${model.inDelivery.length} answered, waiting on agents`,
      `${payload.projects.length} projects`, `${sessions.length} active sessions`, ''].join(' · ') : ''
    return `${counts}fetched ${time}${needsRead}${window.bdNote(workspace)}${errors.length ? ` · ${errors.join(' · ')}` : ''}`
  }

  const keysOf = async (workspaceId, asks) => new Set((await Promise.all(asks.map(async (ask) => {
    const sha = await window.needsModel.cardHash(ask)
    return sha ? window.answerState.keyOf(workspaceId, ask.id, sha) : undefined
  }))).filter(Boolean))

  const isUnanswered = (ask) => !ask.metadata?.['gc.answered']

  const reconcileAnswers = async (workspaceId, data, readStartedAt) => window.answerState.reconcile(workspaceId, {
    listedKeys: await keysOf(workspaceId, data.model.needsYou),
    openKeys: await keysOf(workspaceId, data.model.needsYou.filter(isUnanswered)),
    readStartedAt,
    complete: data.complete,
  })

  window.answerAction.onUnbound(() => {
    document.querySelectorAll('.projects-answer').forEach((node) => node.remove())
  })

  const startProjectsView = (render, { counts = true } = {}) => {
    const ui = Object.fromEntries(['refresh', 'status', 'connect', 'projects']
      .map((id) => [id, document.getElementById(id)]))
    let missing
    const setStatus = (text) => { ui.status.textContent = text }
    const addNotice = (text) => {
      const current = ui.status.textContent
      if (!current.split(' · ').includes(text)) setStatus(current ? `${current} · ${text}` : text)
    }
    const actions = {
      onOpenBead: (id, store, target) => window.openOwn('bead', { id, rig: store, ...(target ? { target } : {}) })
        .catch((error) => setStatus(`Could not open ${id}: ${error.message}`)),
      onOpenRef: (ref) => ref.kind === 'pr'
        ? window.openOwn('pull', { repo: `${ref.owner}/${ref.repo}`, number: ref.number })
          .catch((error) => setStatus(`Could not open ${ref.key}: ${error.message}`))
        : setStatus(`${ref.key}: open it from Pull requests; hvir does not let one extension open another's pages`),
      onOpenProject: (id, store) => window.openOwn('project', { id, store })
        .catch((error) => setStatus(`Could not open ${id}: ${error.message}`)),
      onOpenOverview: () => window.openOwn('project', {})
        .catch((error) => setStatus(`Could not open the overview: ${error.message}`)),
      onAttachSeat: (seat) => window.attachAction.attachSeat(seat)
        .then((result) => setStatus(result?.line ?? ''))
        .catch((error) => setStatus(`Could not open ${seat}: ${error.message}`)),
    }
    const shownBy = new Map()
    let shownId
    const show = (data, context, extra) => {
      const answering = data.answerable && window.answerAction.actionBound() ? { ...actions, workspaceId: context.workspace.id, onAnswer: window.answerAction.answerDecision } : actions
      const needsUnchecked = loader.needsUnchecked(data.stale)
      const shownActions = needsUnchecked ? { ...answering, needsUnchecked } : answering
      const note = render(data, ui.projects, shownActions, context)
      if (data.partial) {
        markLoading(ui.projects)
        setStatus([note, extra].filter(Boolean).join(' · '))
        return
      }
      if (data.stale) ui.projects.prepend(staleLine(data.stale))
      setStatus([note, statusLine(data, context.workspace, counts), extra].filter(Boolean).join(' · '))
    }
    const unrendered = new Set()
    const switchTo = (context) => {
      const id = context.workspace?.id
      if (id === shownId) return
      shownId = id
      const cached = id && shownBy.get(id)
      if (cached) {
        show(cached, context, 'refreshing…')
        return
      }
      ui.projects.replaceChildren()
      ui.connect.hidden = true
      setStatus(id ? 'Loading…' : 'No workspace selected')
    }
    const load = async (context, { hidden = () => false, visible = () => true } = {}) => {
      const { workspace } = context
      if (!workspace) {
        shownId = undefined
        ui.projects.replaceChildren()
        ui.connect.hidden = true
        setStatus('No workspace selected')
        return
      }
      switchTo(context)
      const waiting = shownBy.get(workspace.id)
      if (waiting && unrendered.delete(workspace.id)) show(waiting, context, 'refresh paused: hvir went to the background')
      else if (!waiting) setStatus('Loading…')
      const readStartedAt = Date.now()
      const publishNeeds = async (needs, sessions) => {
        const earlier = shownBy.get(workspace.id)
        if (workspace.id !== shownId || hidden()) return
        const shown = earlier ? withFreshNeeds(earlier, needs) : partialFrom(needs, sessions)
        await reconcileAnswers(workspace.id, shown, readStartedAt)
        if (workspace.id !== shownId) return
        if (earlier) {
          shownBy.set(workspace.id, shown)
          show(shown, context, deferredNote(earlier, 'other sections refreshing…', needs))
        } else show(shown, context, `Needs you read ${ageText(needs.readAt)}; other sections loading…`)
      }
      const data = await read(workspace, { onNeeds: publishNeeds, lastGood: shownBy.get(workspace.id)?.lastGood })
      if (workspace.id !== shownId) return
      missing = data.missing
      ui.connect.hidden = !missing
      if (missing) {
        shownBy.delete(workspace.id)
        ui.connect.textContent = `Connect ${missing}`
        ui.projects.replaceChildren()
        setStatus(window.hostNote(missing, workspace))
        return
      }
      const previous = shownBy.get(workspace.id)
      if (hidden() && data.errors.length) {
        if (previous) {
          show(previous, context, 'refresh paused: hvir went to the background')
          return
        }
        if (!data.projectsRead) {
          setStatus('Paused while hvir is in the background; loads when shown')
          return
        }
        if (!visible()) {
          shownBy.set(workspace.id, data)
          unrendered.add(workspace.id)
          return
        }
      }
      if (data.deferred && previous) {
        const reason = data.errors[0] ?? 'no project list read'
        const kept = { ...previous, lastGood: data.lastGood,
          stale: data.stale ?? { failedAt: data.payload.now, readAt: previous.payload.now } }
        const shown = data.needs ? withFreshNeeds(kept, data.needs) : kept
        if (data.needs) {
          await reconcileAnswers(workspace.id, shown, readStartedAt)
          if (workspace.id !== shownId) return
        }
        shownBy.set(workspace.id, shown)
        show(shown, context, deferredNote(previous, reason, data.needs))
        return
      }
      await reconcileAnswers(workspace.id, data, readStartedAt)
      if (workspace.id !== shownId) return
      shownBy.set(workspace.id, data)
      show(data, context)
    }
    const view = window.startView({ load, refreshMs: 60000, onStatus: setStatus, onNotice: addNotice, onContext: switchTo })
    ui.refresh.addEventListener('click', () => void view.refresh())
    ui.connect.addEventListener('click', () => {
      if (missing) void window.connectHandler(missing, setStatus, view.refresh)()
    })
  }

  window.projectsData = Object.freeze({ read, statusLine, startProjectsView })
})()
