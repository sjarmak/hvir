const { test } = require('node:test')
const assert = require('node:assert/strict')
const loader = require('../projects-load.js')
const { buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')
const workspace = { id: 'city', host: 'ssh-test', root: { host: 'ssh-test', path: '/city' } }
const rigs = [
  { name: 'city', path: '/city', hq: true },
  { name: 'lead', path: '/rigs/lead' },
  { name: 'decisions', path: '/rigs/decisions' },
  { name: 'paused', path: '/rigs/paused', suspended: true },
  { name: 'broken', path: '/rigs/broken' },
]
const city = { cityName: 'city', cityRoot: '/city', hqRigName: 'city', rigs }
const stores = loader.storesFor(workspace, city)
const read = (key, value, store = stores[1]) => ({ key, value, store })

test('argument builders use explicit store scope and unlimited flat JSON lists', () => {
  const base = ['-C', '/rig', 'list', '--json', '--flat', '--no-pager']
  assert.deepEqual(loader.labeledArgs('/rig'),
    [...base, '--all', '--label-any', 'city-project,city-milestone,city-artifact', '-n', '0'])
  assert.deepEqual(loader.inProgressArgs('/rig'), [...base, '--all', '--status', 'in_progress', '-n', '0'])
  assert.deepEqual(loader.stepArgs('/rig', 'root'),
    [...base, '--all', '--metadata-field', 'gc.root_bead_id=root', '-n', '0'])
  assert.deepEqual(loader.showArgs('/rig', ['a', 'b']), ['-C', '/rig', 'show', 'a', 'b', '--json'])
  assert.deepEqual(loader.decisionArgs('/rig'),
    [...base, '--status', 'open', '--has-metadata-key', 'gc.project', '-n', '0'])
})

test('store plan reads workspace HQ once, skips suspended rigs, and uses both decision queries', () => {
  assert.deepEqual(stores.map((store) => store.path), ['/city', '/rigs/lead', '/rigs/decisions', '/rigs/broken'])
  const requests = loader.storeRequests(stores)
  assert.equal(requests.length, 18)
  assert.equal(requests.filter((request) => request.key === 'labeled').length, 4)
  assert.equal(requests.filter((request) => request.key === 'linked').length, 8)
  assert.equal(requests.some((request) => request.args.includes('/rigs/paused')), false)
  const decisions = requests.filter((request) => request.key === 'decisions')
  assert.deepEqual(decisions[0].args, require('../needs-model.js').askArgs('/rigs/decisions'))
  assert.deepEqual(decisions[1].args, loader.decisionArgs('/rigs/decisions'))
  assert.equal(loader.storeRequests([stores[0]]).length, 4)
})

test('one labeled read splits into projects, milestones and artifacts; a failed one reports once', () => {
  const both = { id: 'b', labels: ['city-project', 'city-milestone'] }
  const value = [{ id: 'p', labels: ['city-project'] }, { id: 'a', labels: ['city-artifact'] }, both, { id: 'x' }]
  const split = loader.splitLabeled([read('labeled', value), read('inProgress', [])])
  assert.deepEqual(split.map((entry) => [entry.key, entry.value.map((bead) => bead.id)]), [
    ['projects', ['p', 'b']], ['milestones', ['b']], ['artifacts', ['a']], ['inProgress', []]])
  const failed = loader.splitLabeled([{ ...read('labeled', undefined), error: 'down', notRun: true }])
  assert.deepEqual(failed.map(({ key, error, notRun }) => ({ key, error, notRun })),
    [{ key: 'projects', error: 'down', notRun: true }])
})

test('workflow plans deduplicate roots within each store and cap single-root reads at 30', () => {
  const steps = Array.from({ length: 32 }, (_, i) => ({ metadata: { 'gc.root_bead_id': `root-${i}` } }))
  const reads = [read('inProgress', [...steps, steps[0], {}]), read('inProgress', [steps[0]], stores[0]),
    { key: 'inProgress', store: stores[3], error: 'offline' }]
  const requests = loader.workflowRequests(reads)
  assert.equal(requests.length, 62)
  assert.deepEqual(requests[0].args, loader.showArgs('/rigs/lead', ['root-0']))
  assert.deepEqual(requests[1].args, loader.stepArgs('/rigs/lead', 'root-0'))
  assert.equal(requests.some((request) => request.args.includes('root-30')), false)
  const result = loader.assemblePayload({ now: fixture.now, reads })
  assert.match(result.errors.join(' '), /lead: workflow reads limited to 30 roots/)
  assert.match(result.errors.join(' '), /broken.*offline/)
  assert.deepEqual(result.payload.unread, ['inProgress'])
})

test('a failed linked or decisions read is listed once in unread and the cards stop judging waits', () => {
  const reads = [{ key: 'linked', store: stores[0], error: 'down' }, { key: 'linked', store: stores[1], error: 'down' },
    { key: 'decisions', store: stores[2], error: 'down' }, read('projects', [])]
  const { payload } = loader.assemblePayload({ now: fixture.now, reads })
  assert.deepEqual(payload.unread, ['decisions', 'linked'])
  for (const field of ['linked', 'decisions']) {
    const model = buildDashboard({ now: fixture.now, sessions: [], unread: [field],
      projects: [{ id: 'p', title: 'P', status: 'open', labels: ['city-project'], store: '/city',
        metadata: { 'proj.lead': 'lead', 'proj.state': 'paused', 'proj.waiting_on': '' } }] })
    const card = model.cards.flatMap((group) => group.cards)[0]
    assert.equal(card.derivedState, 'unread', field)
  }
})

test('live sessions preserve model, account, start and agent fields across gc shapes', () => {
  const raw = { session_id: 's', session_name: 'seat', status: 'running', command: ['codex', '--model', 'm'],
    agent_name: 'agent', account: 'account', started_at: fixture.now }
  for (const decoded of [[raw], { sessions: [raw, { id: 'idle', state: 'suspended' },
    { id: 'closed', state: 'closed' }, { id: 'active', state: 'active' }, { id: 'unknown' }] }]) {
    const sessions = loader.liveSessions(decoded)
    assert.equal(sessions[0].id, 's')
    assert.equal(sessions[0].name, 'seat')
    for (const field of ['command', 'agent_name', 'account', 'started_at']) {
      assert.deepEqual(sessions[0][field], raw[field])
    }
    assert.equal(sessions.every((session) => ['active', 'running'].includes(session.state)), true)
  }
  assert.throws(() => loader.liveSessions({ unexpected: [] }), /unexpected JSON shape/)
})

test('fake connector outputs assemble a tagged dashboard despite a failed store', async () => {
  const outputs = {
    projects: fixture.projects, milestones: fixture.milestones, artifacts: fixture.artifacts, inProgress: fixture.inProgress,
    decisions: fixture.decisions, workflowRoots: fixture.workflowRoots, workflowSteps: fixture.workflowSteps, linked: [],
  }
  const execute = async (request) => {
    if (request.store.name === 'broken') return { ...request, error: 'store unavailable' }
    const value = request.store.name === 'lead' || request.key === 'decisions' ? outputs[request.key] : []
    return { ...request, value: structuredClone(value) }
  }
  outputs.labeled = [...fixture.projects, ...fixture.milestones, ...fixture.artifacts]
  const requests = loader.storeRequests(stores)
  const reads = loader.splitLabeled(await Promise.all(requests.map(execute)))
  reads.push(...await Promise.all(loader.workflowRequests(reads).map(execute)))
  const result = loader.assemblePayload({ now: fixture.now, reads,
    sessions: loader.liveSessions(fixture.sessions.map((session) => ({ ...session, state: 'active' }))) })
  assert.equal(result.payload.projects.length, 6)
  assert.equal(result.payload.decisions.length, fixture.decisions.length)
  assert.equal(result.payload.workflowRoots.length, fixture.workflowRoots.length)
  assert.deepEqual(result.payload.seatJobs, [])
  assert.deepEqual(result.payload.refStates, {})
  assert.equal(result.errors.length, 4)
  assert.equal(result.payload.artifacts.length, fixture.artifacts.length)
  assert.equal(result.errors.every((error) => /broken.*store unavailable/.test(error)), true)
  for (const field of Object.keys(outputs).filter((key) => key !== 'labeled')) {
    assert.equal(result.payload[field].every((bead) => bead.store ===
      (field === 'decisions' ? '/rigs/decisions' : '/rigs/lead')), true)
  }
  const dashboard = buildDashboard(result.payload)
  assert.equal(dashboard.cards.flatMap((group) => group.cards).length, 6)
  assert.equal(dashboard.needsYou[0].store, '/rigs/decisions')
  assert.equal(dashboard.activeNow[0].items[0].bead.store, '/rigs/lead')
  assert.equal(dashboard.cards[0].cards[0].refs.prs[0].state, undefined)
  assert.equal(fixture.projects[0].store, undefined)
})

test('assembly retains identical ids in different stores and reports city read failures', () => {
  const bead = { id: 'same', title: 'A project' }
  const result = loader.assemblePayload({ now: fixture.now,
    reads: [read('projects', [bead]), read('projects', [bead], stores[0])],
    errors: ['gc rig list: offline'] })
  assert.deepEqual(result.payload.projects.map((entry) => entry.store), ['/rigs/lead', '/city'])
  assert.deepEqual(result.errors, ['gc rig list: offline'])
  assert.equal(bead.store, undefined)
  assert.doesNotThrow(() => buildDashboard(result.payload))
})

const livePage = (t, page, script) => {
  const { JSDOM } = require('jsdom')
  const { readFileSync } = require('node:fs')
  const dom = new JSDOM(readFileSync(`${__dirname}/../${page}`, 'utf8'), { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  for (const file of ['view', 'crew-parse', 'needs-model', 'projects-load', 'projects-truth', 'projects-model', 'projects-render', 'projects-data']) {
    window.eval(readFileSync(`${__dirname}/../${file}.js`, 'utf8'))
  }
  const page_ = { view: undefined, opened: [], connected: [], bd: 'supported', document: window.document }
  window.startView = (options) => { page_.view = options; return { refresh: async () => {} } }
  window.host = {
    availability: async () => ({ gc: 'supported', bd: page_.bd }),
    run: async (connector, scope, args) => {
      assert.equal(connector, 'gc')
      assert.equal(scope.host, workspace.host)
      return args[0] === 'rig' ? { rigs } : { sessions: [] }
    },
  }
  window.bdRead = async (scope, args) => {
    if (page_.bdError) throw page_.bdError
    if (args[1] === '/rigs/broken') throw new Error('offline')
    if (args.includes('--label-any')) return [{ ...fixture.projects[0], store: undefined }]
    return args.includes('--status') && args.includes('open') ? [fixture.decisions[0]] : []
  }
  window.bdNote = () => ' · store refuses --readonly'
  window.openOwn = async (view, input) => { page_.opened.push({ view, input }) }
  window.connectHandler = (name) => async () => { page_.connected.push(name) }
  window.eval(readFileSync(`${__dirname}/../${script}`, 'utf8'))
  return page_
}

test('overview page wires bead store, unknown refs, partial errors and connector controls', async (t) => {
  const page = livePage(t, 'project.html', 'project.js')
  const { view, opened, connected, document } = page
  assert.equal(view.refreshMs, 60000)
  await view.load({ workspace })
  assert.match(document.getElementById('status').textContent, /broken.*offline/)
  assert.match(document.getElementById('status').textContent, /store refuses --readonly/)
  assert.match(document.getElementById('status').textContent, /need you · \d+ answered, waiting on agents/)
  assert.equal(document.body.textContent.split('Seat jobs not shown yet').length - 1, 1)
  document.querySelector('#projects li button').click()
  assert.equal(opened[0].view, 'bead')
  assert.equal(opened[0].input.rig, '/rigs/decisions')
  document.querySelector('.projects-refs button').click()
  assert.match(document.getElementById('status').textContent, /^fixture-lab\/signals#8: open it from Pull requests/)
  page.bd = 'unsupported'
  await view.load({ workspace })
  document.getElementById('connect').click()
  assert.deepEqual(connected, ['bd'])
})

test('rail rows open the project page and the overview opens as its own tab', async (t) => {
  const { view, opened, document } = livePage(t, 'projects.html', 'projects.js')
  await view.load({ workspace })
  assert.doesNotMatch(document.getElementById('status').textContent, /need you/)
  document.querySelector('.projects-nav-overview').click()
  document.querySelector('.projects-nav-row').click()
  await Promise.resolve()
  assert.deepEqual(opened.map((entry) => entry.view), ['project', 'project'])
  assert.deepEqual(Object.keys(opened[0].input), [])
  assert.equal(opened[1].input.id, fixture.projects[0].id)
  assert.equal(typeof opened[1].input.store, 'string')
})

test('a refresh whose reads did not run keeps the last render, and a revisited workspace shows it at once', async (t) => {
  const page = livePage(t, 'projects.html', 'projects.js')
  const { view, document } = page
  const rows = () => document.querySelectorAll('.projects-nav-row').length
  await view.load({ workspace })
  assert.equal(rows(), 1)
  page.bdError = Object.assign(new Error('bd did not run: capacity'), { reason: 'capacity', transient: true })
  await view.load({ workspace })
  assert.equal(rows(), 1)
  assert.match(document.getElementById('status').textContent, /refresh deferred: .*did not run: capacity/)
  page.bdError = undefined
  const other = { ...workspace, id: 'other' }
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const run = page.document.defaultView.host.run
  page.document.defaultView.host.run = async (...args) => (await gate, run(...args))
  const pending = view.load({ workspace: other })
  assert.equal(rows(), 0)
  assert.equal(document.getElementById('status').textContent, 'Loading…')
  release()
  await pending
  page.document.defaultView.host.run = run
  const back = view.load({ workspace })
  assert.equal(rows(), 1)
  assert.match(document.getElementById('status').textContent, /refreshing…/)
  await back
})

test('project page renders the project named in its input, and says so when it is gone', async (t) => {
  const { view, document } = livePage(t, 'project.html', 'project.js')
  await view.load({ workspace, input: { id: fixture.projects[0].id } })
  assert.equal(document.querySelector('#projects h1').textContent, fixture.projects[0].title)
  await view.load({ workspace, input: { id: 'gone' } })
  assert.match(document.getElementById('projects').textContent, /Project gone not found/)
})

test('HQ comes from the parsed city, not the open workspace folder', () => {
  const inRig = { ...workspace, root: { host: 'ssh-test', path: '/rigs/lead' } }
  assert.deepEqual(loader.storesFor(inRig, city).map((store) => store.path),
    ['/city', '/rigs/lead', '/rigs/decisions', '/rigs/broken'])
  assert.deepEqual(loader.storesFor(inRig, {}).map((store) => store.path), ['/rigs/lead'])
})

test('ancestor plans read unknown parents per store, both dependency shapes, capped and deduplicated', () => {
  const work = [
    { id: 'w1', parent: 'p1' },
    { id: 'w2', dependencies: [{ type: 'parent-child', depends_on_id: 'p2' }, { type: 'blocks', depends_on_id: 'b1' }] },
    { id: 'w3', dependencies: [{ dependency_type: 'parent-child', id: 'p1' }] },
    { id: 'w4', parent: 'known' },
  ]
  const reads = [read('inProgress', work), read('projects', [{ id: 'known' }])]
  assert.deepEqual(loader.ancestorRequests(reads), [
    { store: stores[1], key: 'ancestors', args: loader.showArgs(stores[1].path, ['p1', 'p2']) }])
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `w${index}`, parent: `p${index}` }))
  assert.equal(loader.ancestorRequests([read('inProgress', many)])[0].args.length, 34)
  assert.deepEqual(loader.ancestorRequests([read('inProgress', work), { ...read('inProgress', []), error: 'down' }])
    .map((request) => request.store.path), [stores[1].path])
})

test('fetched ancestors join work to its project through an intermediate parent', () => {
  const project = { id: 'proj', title: 'Project', labels: ['city-project'],
    metadata: { 'proj.state': 'moving', 'proj.lead': 'omni-pl', 'proj.updated_at': fixture.now } }
  const reads = [
    read('projects', [project]),
    read('inProgress', [{ id: 'work', title: 'Work', status: 'in_progress', assignee: 's1', parent: 'epic' }]),
  ]
  assert.deepEqual(loader.ancestorRequests(reads)[0].args, loader.showArgs(stores[1].path, ['epic']))
  reads.push(read('ancestors', [{ id: 'epic', title: 'Epic', parent: 'proj' }]))
  assert.deepEqual(loader.ancestorRequests(reads), [])
  const { payload } = loader.assemblePayload({ now: fixture.now, reads, sessions: [{ id: 's1', name: 's1' }] })
  const group = buildDashboard(payload).activeNow.find((entry) => entry.project?.id === 'proj')
  assert.equal(group.items[0].bead.title, 'Work')
})

test('ancestor plans walk through already-loaded parents to reach unknown ones', () => {
  const reads = [
    read('inProgress', [{ id: 'work', status: 'in_progress', parent: 'ms' }]),
    read('milestones', [{ id: 'ms', parent: 'epic' }]),
  ]
  assert.deepEqual(loader.ancestorRequests(reads)[0].args, loader.showArgs(stores[1].path, ['epic']))
})

test('a failed ancestor read is not retried in later rounds, and cycles plan nothing', () => {
  const reads = [read('inProgress', [{ id: 'work', parent: 'epic' }])]
  const [request] = loader.ancestorRequests(reads)
  reads.push({ ...request, error: 'down' })
  assert.deepEqual(loader.ancestorRequests(reads), [])
  const cycle = [read('inProgress', [{ id: 'a', parent: 'b' }]), read('ancestors', [{ id: 'b', parent: 'a' }])]
  assert.deepEqual(loader.ancestorRequests(cycle), [])
})

test('outcome entries are shape-checked and keep only the contract fields', () => {
  const entry = { time: '2026-10-29T03:00Z', title: 'T', outcome: 'O', projects: ['fx-project-1'], extra: 'x' }
  assert.deepEqual(loader.parseOutcomes({ entries: [entry] }),
    [{ time: '2026-10-29T03:00Z', title: 'T', outcome: 'O', projects: ['fx-project-1'] }])
  for (const bad of [null, {}, { entries: {} }, { entries: [{ ...entry, projects: 'fx' }] }, { entries: [{ ...entry, title: 1 }] }])
    assert.throws(() => loader.parseOutcomes(bad), /unexpected JSON shape/)
  assert.deepEqual([loader.OUTCOME_CONNECTOR, ...loader.OUTCOME_ARGS], ['city-outcomes', '--json'])
})
