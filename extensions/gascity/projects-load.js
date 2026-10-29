;(() => {
  const node = typeof module === 'object'
  const crew = node ? require('./crew-parse.js') : window.crewParse
  const needs = node ? require('./needs-model.js') : window.needsModel
  const fields = ['projects', 'milestones', 'decisions', 'inProgress', 'workflowRoots', 'workflowSteps']
  const listArgs = (path, filter) => [
    '-C', path, 'list', '--json', '--flat', '--no-pager', ...filter, '-n', '0',
  ]
  const projectArgs = (path) => listArgs(path, ['--all', '--label', 'city-project'])
  const milestoneArgs = (path) => listArgs(path, ['--all', '--label', 'city-milestone'])
  const inProgressArgs = (path) => listArgs(path, ['--all', '--status', 'in_progress'])
  const showArgs = (path, ids) => ['-C', path, 'show', ...ids, '--json']
  const stepArgs = (path, id) => listArgs(path,
    ['--all', '--metadata-field', `gc.root_bead_id=${id}`])
  const decisionArgs = (path) => listArgs(path,
    ['--status', 'open', '--has-metadata-key', 'gc.project'])

  const storesFor = (workspace, rigs) => {
    const stores = [{ name: 'HQ', path: workspace.root.path }]
    for (const rig of rigs) {
      if (rig.hq || rig.suspended || stores.some((store) => store.path === rig.path)) continue
      stores.push({ ...rig })
    }
    return stores
  }

  const storeRequests = (stores) => {
    const requests = stores.flatMap((store) => [
      { store, key: 'projects', args: projectArgs(store.path) },
      { store, key: 'milestones', args: milestoneArgs(store.path) },
      { store, key: 'inProgress', args: inProgressArgs(store.path) },
    ])
    const decisions = needs.decisionsRig(stores)
    if (decisions) requests.push(
      { store: decisions, key: 'decisions', args: needs.askArgs(decisions.path) },
      { store: decisions, key: 'decisions', args: decisionArgs(decisions.path) })
    return requests
  }

  const workflowRequests = (reads) => {
    const byStore = new Map()
    for (const { store, key, value, error } of reads) {
      if (key !== 'inProgress' || error) continue
      if (!byStore.has(store.path)) byStore.set(store.path, { store, ids: new Set() })
      for (const bead of value) {
        const id = bead.metadata?.['gc.root_bead_id']
        if (id) byStore.get(store.path).ids.add(id)
      }
    }
    return [...byStore.values()].flatMap(({ store, ids }) => [...ids].slice(0, 30).flatMap((id) => [
      { store, key: 'workflowRoots', args: showArgs(store.path, [id]) },
      { store, key: 'workflowSteps', args: stepArgs(store.path, id) },
    ]))
  }

  const liveSessions = (decoded) => {
    const rows = crew.sessionRows(decoded)
    const raw = new Map(rows.filter((row) => row && typeof row === 'object')
      .map((row) => [row.id ?? row.session_id ?? row.sessionId, row]))
    return crew.parseSessions(decoded)
      .filter((session) => session.state === 'active' || session.state === 'running')
      .map((session) => ({ ...raw.get(session.id), ...session }))
  }

  const assemblePayload = ({ now, reads, sessions = [], errors = [] }) => {
    const payload = { now, sessions, seatJobs: [], refStates: {} }
    const failures = [...errors]
    for (const field of fields) {
      const beads = new Map()
      for (const read of reads.filter((entry) => entry.key === field)) {
        if (read.error) {
          failures.push(`${read.store.name} (${read.store.path}) ${field}: ${read.error}`)
          continue
        }
        for (const bead of read.value) {
          beads.set(`${read.store.path}#${bead.id}`, { ...bead, store: read.store.path })
        }
      }
      payload[field] = [...beads.values()]
    }
    for (const read of reads.filter((entry) => entry.key === 'inProgress' && !entry.error)) {
      const roots = new Set(read.value.map((bead) => bead.metadata?.['gc.root_bead_id']).filter(Boolean))
      if (roots.size > 30) failures.push(`${read.store.name}: workflow reads limited to 30 roots`)
    }
    return { payload, errors: failures }
  }

  const api = Object.freeze({
    projectArgs, milestoneArgs, inProgressArgs, showArgs, stepArgs, decisionArgs,
    storesFor, storeRequests, workflowRequests, liveSessions, assemblePayload,
  })
  if (node) module.exports = api
  else window.projectsLoad = api
})()
