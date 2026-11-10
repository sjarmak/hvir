;(() => {
  const loader = window.projectsLoad

  const readStores = (workspace, requests) => Promise.all(requests.map(async (request) => {
    try {
      const value = await window.bdRead(workspace, request.args)
      if (!Array.isArray(value)) throw new Error('bd returned an unexpected JSON shape')
      return { ...request, value }
    } catch (error) {
      return { ...request, error: error.message, ...(error.reason ? { notRun: true } : {}) }
    }
  }))

  const readCity = async (workspace, args, parse, failures, connector = 'gc') => {
    try {
      return parse(await window.host.run(connector, workspace, args))
    } catch (error) {
      if (error.reason) failures.notRun = true
      failures.errors.push(`${connector} ${args.slice(0, 2).join(' ')}: ${error.message}`)
      return connector === 'gc' ? [] : undefined
    }
  }

  const read = async (workspace) => {
    const connectors = await window.host.availability({ workspace })
    const missing = ['gc', 'bd'].find((name) => connectors[name] !== 'supported')
    if (missing) return { missing }
    const failures = { errors: [], notRun: false }
    const { errors } = failures
    const [city, sessions] = await Promise.all([
      readCity(workspace, ['rig', 'list', '--json'], window.crewParse.parseRigList, failures),
      readCity(workspace, ['session', 'list', '--json'], loader.liveSessions, failures),
    ])
    const stores = loader.storesFor(workspace, Array.isArray(city) ? {} : city)
    const reads = loader.splitLabeled(await readStores(workspace, loader.storeRequests(stores)))
    reads.push(...await readStores(workspace, loader.workflowRequests(reads)))
    for (let round = 0; round < loader.ANCESTOR_ROUNDS; round += 1) {
      const requests = loader.ancestorRequests(reads)
      if (!requests.length) break
      reads.push(...await readStores(workspace, requests))
    }
    if (loader.ancestorRequests(reads).length)
      errors.push(`parent chains deeper than ${loader.ANCESTOR_ROUNDS} unread levels were not followed`)
    const outcomes = connectors[loader.OUTCOME_CONNECTOR] === 'supported'
      ? await readCity(workspace, [...loader.OUTCOME_ARGS], loader.parseOutcomes, failures, loader.OUTCOME_CONNECTOR)
      : undefined
    const result = loader.assemblePayload({ now: new Date().toISOString(), reads, sessions, errors })
    if (outcomes) result.payload.outcomes = outcomes
    const conflicts = window.projectsModel.duplicateProjects(result.payload.projects)
    if (conflicts.length) result.errors.push(`project id in several stores: ${conflicts.join(', ')}`)
    const deferred = failures.notRun || reads.some((entry) => entry.notRun) ||
      !reads.some((entry) => entry.key === 'projects' && !entry.error)
    const answerable = connectors[window.answerAction.CONNECTOR] === 'supported'
    const decisionReads = reads.filter((entry) => entry.key === 'decisions')
    const complete = !deferred && !failures.errors.length && decisionReads.length > 0 && decisionReads.every((entry) => !entry.error)
    return { answerable, complete, model: window.projectsModel.buildDashboard(result.payload), payload: result.payload, errors: result.errors, sessions, deferred }
  }

  const statusLine = (data, workspace, withCounts = true) => {
    const { model, payload, errors, sessions } = data
    const time = new Date(payload.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const counts = withCounts ? [`${model.needsYou.length} need you`, `${model.inDelivery.length} answered, waiting on agents`,
      `${payload.projects.length} projects`, `${sessions.length} active sessions`, ''].join(' · ') : ''
    return `${counts}fetched ${time}${window.bdNote(workspace)}${errors.length ? ` · ${errors.join(' · ')}` : ''}`
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
    const actions = {
      onOpenBead: (id, store) => window.openOwn('bead', { id, rig: store })
        .catch((error) => setStatus(`Could not open ${id}: ${error.message}`)),
      onOpenRef: (ref) => ref.kind === 'pr'
        ? window.openOwn('pull', { repo: `${ref.owner}/${ref.repo}`, number: ref.number })
          .catch((error) => setStatus(`Could not open ${ref.key}: ${error.message}`))
        : setStatus(`${ref.key}: open it from Pull requests; hvir does not let one extension open another's pages`),
      onOpenProject: (id, store) => window.openOwn('project', { id, store })
        .catch((error) => setStatus(`Could not open ${id}: ${error.message}`)),
      onOpenOverview: () => window.openOwn('project', {})
        .catch((error) => setStatus(`Could not open the overview: ${error.message}`)),
    }
    let liveSessions = []
    actions.onOpenSession = (seat) => {
      const session = window.projectsModel.sessionFor(liveSessions, seat)
      return session
        ? window.openOwn('session', { id: session.id })
          .catch((error) => setStatus(`Could not open ${seat}: ${error.message}`))
        : setStatus(`${seat} is asleep`)
    }
    const shownBy = new Map()
    let shownId
    const show = (data, context, extra) => {
      liveSessions = data.sessions
      const shownActions = data.answerable && window.answerAction.actionBound() ? { ...actions, workspaceId: context.workspace.id, onAnswer: window.answerAction.answerDecision } : actions
      const note = render(data, ui.projects, shownActions, context)
      setStatus([note, statusLine(data, context.workspace, counts), extra].filter(Boolean).join(' · '))
    }
    const load = async (context, { hidden = () => false } = {}) => {
      const { workspace } = context
      if (!workspace) {
        shownId = undefined
        ui.projects.replaceChildren()
        ui.connect.hidden = true
        setStatus('No workspace selected')
        return
      }
      if (workspace.id !== shownId) {
        shownId = workspace.id
        const cached = shownBy.get(workspace.id)
        if (cached) show(cached, context, 'refreshing…')
        else {
          ui.projects.replaceChildren()
          setStatus('Loading…')
        }
      }
      const readStartedAt = Date.now()
      const data = await read(workspace)
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
        if (previous) show(previous, context, 'refresh paused: hvir went to the background')
        else setStatus('Paused while hvir is in the background; loads when shown')
        return
      }
      if (data.deferred && previous) {
        show(previous, context, `refresh deferred: ${data.errors[0] ?? 'no project list read'}`)
        return
      }
      await reconcileAnswers(workspace.id, data, readStartedAt)
      if (workspace.id !== shownId) return
      shownBy.set(workspace.id, data)
      show(data, context)
    }
    const view = window.startView({ load, refreshMs: 60000, onStatus: setStatus })
    ui.refresh.addEventListener('click', () => void view.refresh())
    ui.connect.addEventListener('click', () => {
      if (missing) void window.connectHandler(missing, setStatus, view.refresh)()
    })
  }

  window.projectsData = Object.freeze({ read, statusLine, startProjectsView })
})()
