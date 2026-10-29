;(() => {
  const { run, availability } = window.host
  const loader = window.projectsLoad
  const ui = Object.fromEntries(['refresh', 'status', 'connect', 'projects']
    .map((id) => [id, document.getElementById(id)]))
  let missing

  const setStatus = (text) => { ui.status.textContent = text }
  const render = (payload) => window.projectsRender.renderDashboard(
    window.projectsModel.buildDashboard(payload), ui.projects, {
      seatJobsUnavailable: true,
      onOpenBead: (id, store) => window.openOwn('bead', { id, rig: store })
        .catch((error) => setStatus(`Could not open ${id}: ${error.message}`)),
      onOpenRef: (ref) => setStatus(ref.key),
    })

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
      return parse(await run(connector, workspace, args))
    } catch (error) {
      errors.push(`${connector} ${args.slice(0, 2).join(' ')}: ${error.message}`)
      return connector === 'gc' ? [] : undefined
    }
  }

  const load = async ({ workspace }) => {
    if (!workspace) {
      ui.projects.replaceChildren()
      ui.connect.hidden = true
      setStatus('No workspace selected')
      return
    }
    const connectors = await availability({ workspace })
    missing = ['gc', 'bd'].find((name) => connectors[name] !== 'supported')
    const outcomesReady = connectors['city-projects'] === 'supported'
    ui.connect.hidden = !missing
    if (missing) {
      ui.connect.textContent = `Connect ${missing}`
      ui.projects.replaceChildren()
      setStatus(window.hostNote(missing, workspace))
      return
    }
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
    const outcomes = outcomesReady
      ? await readCity(workspace, [...loader.OUTCOME_ARGS], loader.parseOutcomes, errors, 'city-projects')
      : undefined
    const result = loader.assemblePayload({ now: new Date().toISOString(), reads, sessions, errors })
    if (outcomes) result.payload.outcomes = outcomes
    render(result.payload)
    const time = new Date(result.payload.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const conflicts = window.projectsModel.duplicateProjects(result.payload.projects)
    if (conflicts.length) result.errors.push(`project id in several stores: ${conflicts.join(', ')}`)
    const counts = `${result.payload.projects.length} projects · ${result.payload.decisions.length} open decisions · ${sessions.length} active sessions`
    setStatus(`${counts} · updated ${time}${window.bdNote(workspace)}${result.errors.length ? ` · ${result.errors.join(' · ')}` : ''}`)
  }

  const view = window.startView({ load, refreshMs: 60000, onStatus: setStatus })
  ui.refresh.addEventListener('click', () => void view.refresh())
  ui.connect.addEventListener('click', () => {
    if (missing) void window.connectHandler(missing, setStatus, view.refresh)()
  })
})()
