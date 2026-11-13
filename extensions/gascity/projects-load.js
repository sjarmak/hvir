;(() => {
  const node = typeof module === 'object'
  const crew = node ? require('./crew-parse.js') : window.crewParse
  const needs = node ? require('./needs-model.js') : window.needsModel
  const fields = ['projects', 'milestones', 'artifacts', 'decisions', 'herSteps', 'inProgress', 'linked', 'workflowRoots', 'workflowSteps', 'ancestors', 'urgent']
  const ROOT_CAP = 30
  const ANCESTOR_CAP = 30
  const ANCESTOR_ROUNDS = 3
  const listArgs = (path, filter) => [
    '-C', path, 'list', '--json', '--flat', '--no-pager', ...filter, '-n', '0',
  ]
  const LABEL_FIELDS = Object.freeze({ 'city-project': 'projects', 'city-milestone': 'milestones', 'city-artifact': 'artifacts' })
  const labeledArgs = (path) => listArgs(path, ['--all', '--label-any', Object.keys(LABEL_FIELDS).join(',')])
  const inProgressArgs = (path) => listArgs(path, ['--all', '--status', 'in_progress'])
  const linkedArgs = (path, key) => listArgs(path, ['--status', 'open,in_progress,blocked,deferred', '--has-metadata-key', key])
  const urgentArgs = (path) => listArgs(path, ['--status', 'open,in_progress', '--priority-max', '1'])
  const showArgs = (path, ids) => ['-C', path, 'show', ...ids, '--json']
  const stepArgs = (path, id) => listArgs(path,
    ['--all', '--metadata-field', `gc.root_bead_id=${id}`])
  const decisionArgs = (path) => listArgs(path,
    ['--status', 'open', '--has-metadata-key', 'gc.project'])

  const storesFor = (workspace, city) => {
    const stores = [{ name: city.hqRigName ?? 'HQ', path: city.cityRoot ?? workspace.root.path }]
    for (const rig of city.rigs ?? []) {
      if (rig.hq || rig.suspended || stores.some((store) => store.path === rig.path)) continue
      stores.push({ ...rig })
    }
    return stores
  }

  const storeRequests = (stores) => {
    const requests = stores.flatMap((store) => [
      { store, key: 'labeled', args: labeledArgs(store.path) },
      { store, key: 'inProgress', args: inProgressArgs(store.path) },
      { store, key: 'linked', args: linkedArgs(store.path, 'proj.id') },
      { store, key: 'linked', args: linkedArgs(store.path, 'gc.project') },
      { store, key: 'urgent', args: urgentArgs(store.path) },
    ])
    const decisions = needs.decisionsRig(stores)
    if (decisions) requests.push(
      { store: decisions, key: 'decisions', args: needs.askArgs(decisions.path) },
      { store: decisions, key: 'herSteps', args: needs.stepArgs(decisions.path) },
      { store: decisions, key: 'decisions', args: decisionArgs(decisions.path) })
    return requests
  }

  const splitLabeled = (reads) => reads.flatMap((read) => {
    if (read.key !== 'labeled') return [read]
    if (read.error) return [{ ...read, key: 'projects' }]
    return Object.entries(LABEL_FIELDS).map(([label, key]) =>
      ({ ...read, key, value: read.value.filter((bead) => (bead.labels ?? []).includes(label)) }))
  })

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
    return [...byStore.values()].flatMap(({ store, ids }) => [...ids].slice(0, ROOT_CAP).flatMap((id) => [
      { store, key: 'workflowRoots', args: showArgs(store.path, [id]) },
      { store, key: 'workflowSteps', args: stepArgs(store.path, id) },
    ]))
  }

  const parentIds = (bead) => [bead.parent, ...(bead.dependencies ?? [])
    .filter((dependency) => (dependency.type ?? dependency.dependency_type) === 'parent-child')
    .map((dependency) => dependency.depends_on_id ?? dependency.id)].filter(Boolean)

  const missingParents = (beads, starts) => {
    const wanted = new Set()
    const seen = new Set()
    const pending = [...starts]
    while (pending.length) {
      const bead = pending.pop()
      if (seen.has(bead.id)) continue
      seen.add(bead.id)
      for (const id of parentIds(bead)) {
        if (beads.has(id)) pending.push(beads.get(id))
        else wanted.add(id)
      }
    }
    return wanted
  }

  const ancestorRequests = (reads) => {
    const byStore = new Map()
    const entry = (store) => {
      if (!byStore.has(store.path)) byStore.set(store.path, { store, beads: new Map(), failed: new Set(), starts: [] })
      return byStore.get(store.path)
    }
    for (const { store, key, value, error, args } of reads) {
      if (error) {
        if (key === 'ancestors') for (const id of args.slice(3, -1)) entry(store).failed.add(id)
        continue
      }
      for (const bead of value) entry(store).beads.set(bead.id, bead)
      if (['inProgress', 'workflowRoots'].includes(key)) entry(store).starts.push(...value)
    }
    return [...byStore.values()].flatMap(({ store, beads, failed, starts }) => {
      const ids = [...missingParents(beads, starts)].filter((id) => !failed.has(id)).slice(0, ANCESTOR_CAP)
      return ids.length ? [{ store, key: 'ancestors', args: showArgs(store.path, ids) }] : []
    })
  }

  const OUTCOME_CONNECTOR = 'city-outcomes'
  const OUTCOME_ARGS = Object.freeze(['--json'])

  const parseOutcomes = (decoded) => {
    const entries = decoded?.entries
    const valid = (entry) => entry && typeof entry.time === 'string' && typeof entry.title === 'string' &&
      typeof entry.outcome === 'string' && Array.isArray(entry.projects) &&
      entry.projects.every((id) => typeof id === 'string')
    if (!Array.isArray(entries) || !entries.every(valid))
      throw new Error('city-projects-outcomes returned an unexpected JSON shape')
    return entries.map(({ time, title, outcome, projects }) => ({ time, title, outcome, projects }))
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
    const payload = { now, sessions, seatJobs: [], refStates: {}, unread: [] }
    const failures = [...errors]
    for (const field of fields) {
      const beads = new Map()
      for (const read of reads.filter((entry) => entry.key === field)) {
        if (read.error) {
          failures.push(`${read.store.name} (${read.store.path}) ${field}: ${read.error}`)
          if (!payload.unread.includes(field)) payload.unread.push(field)
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
      if (roots.size > ROOT_CAP) failures.push(`${read.store.name}: workflow reads limited to ${ROOT_CAP} roots`)
    }
    return { payload, errors: failures }
  }

  const BOARD = Object.freeze([...fields, 'sessions', 'outcomes'])
  const NEEDS_FIELDS = Object.freeze(['decisions', 'herSteps'])
  const NEEDS_CHECK_LIMIT_MS = 10 * 60000
  const failedFields = (unread) => unread.includes('projects') ? [...unread, ...Object.values(LABEL_FIELDS)] : unread

  const keepLastGood = ({ payload, lastGood = {} }) => {
    const unread = payload.unread ?? []
    const failed = failedFields(unread)
    const boardFailed = BOARD.some((field) => failed.includes(field))
    const needsClean = NEEDS_FIELDS.every((field) => !failed.includes(field))
    const needsAt = needsClean ? payload.now : lastGood.needsAt
    const board = boardFailed ? lastGood.board : { values: Object.fromEntries(BOARD.map((field) => [field, payload[field]])), at: payload.now }
    const nextLastGood = { ...lastGood, ...(board ? { board } : {}), ...(needsAt ? { needsAt } : {}) }
    const kept = boardFailed && board
    if (!kept) return { payload, lastGood: nextLastGood, stale: null, needsAt }
    return {
      payload: { ...payload, ...kept.values, unread: unread.filter((field) => !BOARD.includes(field)) },
      lastGood: nextLastGood,
      stale: { failedAt: payload.now, readAt: kept.at },
      needsAt: kept.at,
    }
  }

  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const dated = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const stamp = (iso, now) => new Date(iso).toDateString() === new Date(now).toDateString() ? clock(iso) : dated(iso)

  const staleText = ({ failedAt, readAt }, now = Date.now()) =>
    `Couldn't refresh at ${stamp(failedAt, now)}; showing what was read at ${stamp(readAt, now)}`

  const needsUnchecked = (needsAt, now) => {
    if (!needsAt) return "Couldn't check what needs you yet"
    return now - Date.parse(needsAt) > NEEDS_CHECK_LIMIT_MS ? `Couldn't check what needs you since ${dated(needsAt)}` : null
  }

  const api = Object.freeze({
    labeledArgs, splitLabeled, inProgressArgs, urgentArgs, linkedArgs, showArgs, stepArgs, decisionArgs,
    ANCESTOR_ROUNDS, OUTCOME_CONNECTOR, OUTCOME_ARGS, parseOutcomes, storesFor, storeRequests, workflowRequests, ancestorRequests, liveSessions, assemblePayload,
    keepLastGood, NEEDS_CHECK_LIMIT_MS, staleText, needsUnchecked,
  })
  if (node) module.exports = api
  else window.projectsLoad = api
})()
