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
const stores = loader.storesFor(workspace, rigs)
const read = (key, value, store = stores[1]) => ({ key, value, store })

test('argument builders use explicit store scope and unlimited flat JSON lists', () => {
  const base = ['-C', '/rig', 'list', '--json', '--flat', '--no-pager']
  assert.deepEqual(loader.projectArgs('/rig'), [...base, '--all', '--label', 'city-project', '-n', '0'])
  assert.deepEqual(loader.milestoneArgs('/rig'), [...base, '--all', '--label', 'city-milestone', '-n', '0'])
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
  assert.equal(requests.length, 14)
  assert.equal(requests.some((request) => request.args.includes('/rigs/paused')), false)
  const decisions = requests.filter((request) => request.key === 'decisions')
  assert.deepEqual(decisions[0].args, require('../needs-model.js').askArgs('/rigs/decisions'))
  assert.deepEqual(decisions[1].args, loader.decisionArgs('/rigs/decisions'))
  assert.equal(loader.storeRequests([stores[0]]).length, 3)
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
    projects: fixture.projects, milestones: fixture.milestones, inProgress: fixture.inProgress,
    decisions: fixture.decisions, workflowRoots: fixture.workflowRoots, workflowSteps: fixture.workflowSteps,
  }
  const execute = async (request) => {
    if (request.store.name === 'broken') return { ...request, error: 'store unavailable' }
    const value = request.store.name === 'lead' || request.key === 'decisions' ? outputs[request.key] : []
    return { ...request, value: structuredClone(value) }
  }
  const requests = loader.storeRequests(stores)
  const reads = await Promise.all(requests.map(execute))
  reads.push(...await Promise.all(loader.workflowRequests(reads).map(execute)))
  const result = loader.assemblePayload({ now: fixture.now, reads,
    sessions: loader.liveSessions(fixture.sessions.map((session) => ({ ...session, state: 'active' }))) })
  assert.equal(result.payload.projects.length, 6)
  assert.equal(result.payload.decisions.length, fixture.decisions.length)
  assert.equal(result.payload.workflowRoots.length, fixture.workflowRoots.length)
  assert.deepEqual(result.payload.seatJobs, [])
  assert.deepEqual(result.payload.refStates, {})
  assert.equal(result.errors.length, 3)
  assert.equal(result.errors.every((error) => /broken.*store unavailable/.test(error)), true)
  for (const field of Object.keys(outputs)) {
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

test('live page wires bead store, unknown refs, partial errors and connector controls', async (t) => {
  const { JSDOM } = require('jsdom')
  const { readFileSync } = require('node:fs')
  const dom = new JSDOM(readFileSync(`${__dirname}/../projects.html`, 'utf8'), { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  for (const file of ['view', 'crew-parse', 'needs-model', 'projects-load', 'projects-model', 'projects-render']) {
    window.eval(readFileSync(`${__dirname}/../${file}.js`, 'utf8'))
  }
  let view
  const opened = []
  const connected = []
  let bd = 'supported'
  window.startView = (options) => { view = options; return { refresh: async () => {} } }
  window.host = {
    availability: async () => ({ gc: 'supported', bd }),
    run: async (connector, scope, args) => {
      assert.equal(connector, 'gc')
      assert.equal(scope.host, workspace.host)
      return args[0] === 'rig' ? { rigs } : { sessions: [] }
    },
  }
  window.bdRead = async (scope, args) => {
    if (args[1] === '/rigs/broken') throw new Error('offline')
    return args.includes('--status') && args.includes('open') ? [fixture.decisions[0]] : []
  }
  window.bdNote = () => ' · store refuses --readonly'
  window.openOwn = async (view, input) => { opened.push({ view, input }) }
  window.connectHandler = (name) => async () => { connected.push(name) }
  window.eval(readFileSync(`${__dirname}/../projects.js`, 'utf8'))
  assert.equal(view.refreshMs, 60000)
  await view.load({ workspace })
  const document = window.document
  assert.match(document.getElementById('status').textContent, /broken.*offline/)
  assert.match(document.getElementById('status').textContent, /store refuses --readonly/)
  assert.equal(document.body.textContent.split('Seat jobs not shown yet').length - 1, 1)
  document.querySelector('#projects li button').click()
  assert.equal(opened[0].view, 'bead')
  assert.equal(opened[0].input.rig, '/rigs/decisions')
  document.querySelector('.projects-refs button').click()
  assert.equal(document.getElementById('status').textContent, 'fixture-lab/signals#8')
  bd = 'unsupported'
  await view.load({ workspace })
  document.getElementById('connect').click()
  assert.deepEqual(connected, ['bd'])
})
