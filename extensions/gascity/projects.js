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

  const readCity = async (workspace, args, parse, errors) => {
    try {
      return parse(await run('gc', workspace, args))
    } catch (error) {
      errors.push(`gc ${args.slice(0, 2).join(' ')}: ${error.message}`)
      return []
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
    ui.connect.hidden = !missing
    if (missing) {
      ui.connect.textContent = `Connect ${missing}`
      ui.projects.replaceChildren()
      setStatus(window.hostNote(missing, workspace))
      return
    }
    const errors = []
    const [rigs, sessions] = await Promise.all([
      readCity(workspace, ['rig', 'list', '--json'],
        (value) => window.crewParse.parseRigList(value).rigs, errors),
      readCity(workspace, ['session', 'list', '--json'], loader.liveSessions, errors),
    ])
    const stores = loader.storesFor(workspace, rigs)
    const reads = await readStores(workspace, loader.storeRequests(stores))
    reads.push(...await readStores(workspace, loader.workflowRequests(reads)))
    const result = loader.assemblePayload({ now: new Date().toISOString(), reads, sessions, errors })
    render(result.payload)
    const time = new Date(result.payload.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const counts = `${result.payload.projects.length} projects · ${result.payload.decisions.length} open decisions · ${sessions.length} active sessions`
    setStatus(`${counts} · updated ${time}${window.bdNote(workspace)}${result.errors.length ? ` · ${result.errors.join(' · ')}` : ''}`)
  }

  const view = window.startView({ load, refreshMs: 60000, onStatus: setStatus })
  ui.refresh.addEventListener('click', () => void view.refresh())
  ui.connect.addEventListener('click', () => {
    if (missing) void window.connectHandler(missing, setStatus, view.refresh)()
  })
})()
