;(() => {
  const loader = window.projectsLoad

  const readStores = (workspace, requests) => Promise.all(requests.map(async (request) => {
    try {
      const value = await window.bdRead(workspace, request.args)
      if (!Array.isArray(value)) throw new Error('bd returned an unexpected JSON shape')
      return { ...request, value }
    } catch (error) {
      return { ...request, error: error.message }
    }
  }))

  const readCity = async (workspace, args, parse, errors, connector = 'gc') => {
    try {
      return parse(await window.host.run(connector, workspace, args))
    } catch (error) {
      errors.push(`${connector} ${args.slice(0, 2).join(' ')}: ${error.message}`)
      return connector === 'gc' ? [] : undefined
    }
  }

  const read = async (workspace) => {
    const connectors = await window.host.availability({ workspace })
    const missing = ['gc', 'bd'].find((name) => connectors[name] !== 'supported')
    if (missing) return { missing }
    const errors = []
    const [city, sessions] = await Promise.all([
      readCity(workspace, ['rig', 'list', '--json'], window.crewParse.parseRigList, errors),
      readCity(workspace, ['session', 'list', '--json'], loader.liveSessions, errors),
    ])
    const stores = loader.storesFor(workspace, Array.isArray(city) ? {} : city)
    const reads = await readStores(workspace, loader.storeRequests(stores))
    reads.push(...await readStores(workspace, loader.workflowRequests(reads)))
    for (let round = 0; round < loader.ANCESTOR_ROUNDS; round += 1) {
      const requests = loader.ancestorRequests(reads)
      if (!requests.length) break
      reads.push(...await readStores(workspace, requests))
    }
    if (loader.ancestorRequests(reads).length)
      errors.push(`parent chains deeper than ${loader.ANCESTOR_ROUNDS} unread levels were not followed`)
    const outcomes = connectors[loader.OUTCOME_CONNECTOR] === 'supported'
      ? await readCity(workspace, [...loader.OUTCOME_ARGS], loader.parseOutcomes, errors, loader.OUTCOME_CONNECTOR)
      : undefined
    const result = loader.assemblePayload({ now: new Date().toISOString(), reads, sessions, errors })
    if (outcomes) result.payload.outcomes = outcomes
    const conflicts = window.projectsModel.duplicateProjects(result.payload.projects)
    if (conflicts.length) result.errors.push(`project id in several stores: ${conflicts.join(', ')}`)
    return { model: window.projectsModel.buildDashboard(result.payload), payload: result.payload, errors: result.errors, sessions }
  }

  const statusLine = (data, workspace, withCounts = true) => {
    const { model, payload, errors, sessions } = data
    const time = new Date(payload.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const counts = withCounts ? [`${model.needsYou.length} need you`, `${model.inDelivery.length} answered, waiting on agents`,
      `${payload.projects.length} projects`, `${sessions.length} active sessions`, ''].join(' · ') : ''
    return `${counts}updated ${time}${window.bdNote(workspace)}${errors.length ? ` · ${errors.join(' · ')}` : ''}`
  }

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
    const load = async (context) => {
      const { workspace } = context
      if (!workspace) {
        ui.projects.replaceChildren()
        ui.connect.hidden = true
        setStatus('No workspace selected')
        return
      }
      const data = await read(workspace)
      missing = data.missing
      ui.connect.hidden = !missing
      if (missing) {
        ui.connect.textContent = `Connect ${missing}`
        ui.projects.replaceChildren()
        setStatus(window.hostNote(missing, workspace))
        return
      }
      const note = render(data, ui.projects, actions, context)
      setStatus([note, statusLine(data, workspace, counts)].filter(Boolean).join(' · '))
    }
    const view = window.startView({ load, refreshMs: 60000, onStatus: setStatus })
    ui.refresh.addEventListener('click', () => void view.refresh())
    ui.connect.addEventListener('click', () => {
      if (missing) void window.connectHandler(missing, setStatus, view.refresh)()
    })
  }

  window.projectsData = Object.freeze({ read, statusLine, startProjectsView })
})()
