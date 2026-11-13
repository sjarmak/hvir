const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const loader = require('../projects-load.js')

const KEPT = [
  'projects',
  'milestones',
  'artifacts',
  'decisions',
  'herSteps',
  'inProgress',
  'linked',
  'workflowRoots',
  'workflowSteps',
  'ancestors',
  'urgent',
  'outcomes',
  'sessions',
]
const EARLY = '2026-11-13T02:43:00.000Z'
const LATE = '2026-11-13T02:48:00.000Z'

const fullPayload = (now, tag) => ({
  now,
  unread: [],
  ...Object.fromEntries(KEPT.map((field) => [field, [{ id: `${field}-${tag}` }]])),
})

test('a first read keeps every cleanly read field as the last good read and is not stale', () => {
  const result = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  assert.equal(result.stale, null)
  assert.deepEqual(result.payload, fullPayload(EARLY, 'a'))
  for (const field of KEPT)
    assert.deepEqual(result.lastGood[field], { value: [{ id: `${field}-a` }], at: EARLY })
})

for (const field of KEPT.filter((entry) => entry !== 'projects')) {
  test(`a failed ${field} read keeps that field's last good read and marks the view stale`, () => {
    const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
    const failed = { ...fullPayload(LATE, 'b'), [field]: [], unread: [field] }
    const result = loader.keepLastGood({ payload: failed, lastGood: first.lastGood })
    assert.deepEqual(result.payload[field], [{ id: `${field}-a` }])
    assert.deepEqual(result.payload.unread, [])
    for (const other of KEPT.filter((entry) => entry !== field))
      assert.deepEqual(result.payload[other], [{ id: `${other}-b` }])
    assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY })
    assert.deepEqual(result.lastGood[field], { value: [{ id: `${field}-a` }], at: EARLY })
  })
}

test('a failed projects read keeps the milestones and artifacts from the same labelled read too', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const failed = {
    ...fullPayload(LATE, 'b'),
    projects: [],
    milestones: [],
    artifacts: [],
    unread: ['projects'],
  }
  const result = loader.keepLastGood({ payload: failed, lastGood: first.lastGood })
  for (const field of ['projects', 'milestones', 'artifacts'])
    assert.deepEqual(result.payload[field], [{ id: `${field}-a` }])
  assert.deepEqual(result.payload.linked, [{ id: 'linked-b' }])
  assert.deepEqual(result.payload.unread, [])
  assert.deepEqual(result.stale, { failedAt: LATE, readAt: EARLY })
})

test('a field that has never read cleanly stays unread and does not mark the view stale', () => {
  const failed = { ...fullPayload(EARLY, 'a'), linked: [], unread: ['linked'] }
  const result = loader.keepLastGood({ payload: failed })
  assert.deepEqual(result.payload.linked, [])
  assert.deepEqual(result.payload.unread, ['linked'])
  assert.equal(result.stale, null)
  assert.equal(result.lastGood.linked, undefined)
})

test('a field failing twice keeps the read from before both failures', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const middle = '2026-11-13T02:45:00.000Z'
  const second = loader.keepLastGood({
    payload: { ...fullPayload(middle, 'b'), linked: [], unread: ['linked'] },
    lastGood: first.lastGood,
  })
  const third = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'c'), linked: [], unread: ['linked'] },
    lastGood: second.lastGood,
  })
  assert.deepEqual(third.payload.linked, [{ id: 'linked-a' }])
  assert.deepEqual(third.stale, { failedAt: LATE, readAt: EARLY })
})

test('a clean read after a failed one replaces the kept field and clears the stale mark', () => {
  const first = loader.keepLastGood({ payload: fullPayload(EARLY, 'a') })
  const failed = loader.keepLastGood({
    payload: { ...fullPayload(LATE, 'b'), linked: [], unread: ['linked'] },
    lastGood: first.lastGood,
  })
  const later = '2026-11-13T02:50:00.000Z'
  const result = loader.keepLastGood({
    payload: fullPayload(later, 'c'),
    lastGood: failed.lastGood,
  })
  assert.equal(result.stale, null)
  assert.deepEqual(result.payload.linked, [{ id: 'linked-c' }])
  assert.deepEqual(result.lastGood.linked, { value: [{ id: 'linked-c' }], at: later })
})

const workspace = {
  id: 'city',
  host: 'ssh-test',
  root: { host: 'ssh-test', path: '/city' },
}
const rigs = [
  { name: 'city', path: '/city', hq: true },
  { name: 'lead', path: '/rigs/lead' },
  { name: 'decisions', path: '/rigs/decisions' },
]
const project = {
  id: 'pj-1',
  title: 'Lantern catalog',
  status: 'open',
  labels: ['city-project'],
  metadata: { 'proj.lead': 'lead-a', 'proj.state': 'waiting', 'proj.waiting_on': 'wk-1' },
}

const isLinked = (args) =>
  args.includes('--has-metadata-key') &&
  args.includes('open,in_progress,blocked,deferred')
const isInProgress = (args) =>
  args.includes('in_progress') && args.includes('--all') && !args.includes('--label-any')
const isUrgent = (args) => args.includes('--priority-max')
const isDecisions = (args) =>
  args[1] === '/rigs/decisions' &&
  !args.includes('--label-any') &&
  !isLinked(args) &&
  !isUrgent(args) &&
  !isInProgress(args)

const livePage = (t) => {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM(readFileSync(`${__dirname}/../projects.html`, 'utf8'), {
    runScripts: 'outside-only',
  })
  t.after(() => dom.window.close())
  const { window } = dom
  Object.defineProperty(window, 'crypto', {
    value: require('node:crypto').webcrypto,
    configurable: true,
  })
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder, configurable: true })
  window.hvirExtension = { onMessage: () => () => {}, send: () => {} }
  for (const file of [
    'view',
    'card-words',
    'wait-model',
    'crew-parse',
    'needs-model',
    'projects-load',
    'projects-truth',
    'projects-model',
    'answer-state',
    'projects-render',
    'answer',
    'attach',
    'projects-data',
    'projects-seen',
  ])
    window.eval(readFileSync(`${__dirname}/../${file}.js`, 'utf8'))
  const page = {
    view: undefined,
    failing: () => false,
    document: window.document,
    clock: Date.parse(EARLY),
  }
  window.Date.now = () => page.clock
  window.startView = (options) => {
    page.view = options
    return { refresh: async () => {} }
  }
  window.host = {
    availability: async () => ({ gc: 'supported', bd: 'supported' }),
    run: async (connector, scope, args) =>
      args[0] === 'rig' ? { rigs } : { sessions: [] },
  }
  window.bdRead = async (scope, args) => {
    if (page.failing(args)) throw new Error('dolt server restarting')
    if (args.includes('--label-any')) return args[1] === '/city' ? [project] : []
    if (isLinked(args) && args[1] === '/rigs/lead' && args.includes('proj.id'))
      return [
        {
          id: 'wk-1',
          title: 'Index rebuild',
          status: 'open',
          priority: 1,
          updated_at: new Date(page.clock).toISOString(),
          metadata: { 'proj.id': 'pj-1', 'gc.waiting_on': 'lead-a' },
        },
      ]
    return []
  }
  window.bdNote = () => ''
  window.openOwn = async () => {}
  window.connectHandler = () => async () => {}
  window.eval(readFileSync(`${__dirname}/../projects.js`, 'utf8'))
  return page
}

const clock = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const chipOf = (document) =>
  document.querySelector('.projects-nav-row .projects-chip')?.dataset.state
const waitingRows = (document) =>
  [...document.querySelectorAll('section')]
    .filter((node) => node.querySelector('h2')?.textContent.startsWith('Waiting on'))
    .flatMap((node) => [...node.querySelectorAll('li')].map((row) => row.title))
const staleLine = (document) => document.querySelector('#projects .projects-stale')

const reads = {
  linked: isLinked,
  inProgress: isInProgress,
  urgent: isUrgent,
  decisions: isDecisions,
}

for (const [name, failing] of Object.entries(reads)) {
  test(`a refresh whose ${name} read fails keeps the cards and Waiting on, and says what time it shows`, async (t) => {
    const page = livePage(t)
    const { document } = page
    await page.view.load({ workspace })
    const before = { chip: chipOf(document), waiting: waitingRows(document) }
    assert.equal(before.chip, 'waiting')
    assert.deepEqual(before.waiting, ['wk-1'])
    assert.equal(staleLine(document), null)
    page.clock = Date.parse(LATE)
    page.failing = failing
    await page.view.load({ workspace })
    assert.equal(chipOf(document), before.chip)
    assert.deepEqual(waitingRows(document), before.waiting)
    const line = staleLine(document)
    assert.ok(line.classList.contains('projects-warning'))
    assert.equal(
      line.textContent,
      `Couldn't refresh at ${clock(LATE)}; showing what was read at ${clock(EARLY)}`,
    )
  })
}

test('a first load whose linked read fails shows the cards as unread with no stale line', async (t) => {
  const page = livePage(t)
  const { document } = page
  page.failing = isLinked
  await page.view.load({ workspace })
  assert.equal(chipOf(document), 'unread')
  assert.deepEqual(waitingRows(document), [])
  assert.equal(staleLine(document), null)
})

test('a good refresh after a failed one removes the stale line and shows the new read', async (t) => {
  const page = livePage(t)
  const { document } = page
  await page.view.load({ workspace })
  page.clock = Date.parse(LATE)
  page.failing = isLinked
  await page.view.load({ workspace })
  assert.ok(staleLine(document))
  page.clock = Date.parse('2026-11-13T02:50:00.000Z')
  page.failing = () => false
  project.metadata = { ...project.metadata, 'proj.waiting_on': 'none' }
  t.after(() => {
    project.metadata = { ...project.metadata, 'proj.waiting_on': 'wk-1' }
  })
  await page.view.load({ workspace })
  assert.equal(staleLine(document), null)
  assert.equal(chipOf(document), 'queued')
})
