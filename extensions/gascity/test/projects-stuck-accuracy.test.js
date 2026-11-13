const { test } = require('node:test')
const assert = require('node:assert/strict')
const loader = require('../projects-load.js')
const { buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')

const fresh = () => structuredClone(fixture)
const urgent = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  status: 'open',
  priority: 1,
  labels: [],
  store: 's',
  updated_at: '2026-10-28T08:00:00Z',
  metadata: {},
  ...extra,
})
const tracks = (id, ...targets) =>
  targets.map((target) => ({ issue_id: id, depends_on_id: target, type: 'tracks' }))
const allRows = (model) =>
  [model.stuck, model.working, model.waiting, model.notStarted].flatMap(
    (group) => group.items,
  )
const stuckIds = (model) => model.stuck.items.map((row) => row.id)

test('an ordinary task with a tracks edge to an unloaded item is not a convoy and stays in Stuck', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-task-tracks', {
      issue_type: 'task',
      dependencies: tracks('fx-task-tracks', 'fx-unloaded'),
    }),
  ]
  const model = buildDashboard(input)
  assert.deepEqual(stuckIds(model), ['fx-task-tracks'])
  assert.ok(!allRows(model).some((row) => row.id === 'fx-unloaded'))
})

test('an item a live session runs is never stuck, even when its named wait is over a day old', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-live-wait', {
      updated_at: '2026-10-27T08:00:00Z',
      metadata: { 'gc.session_name': 'fx-worker-a', 'gc.waiting_on': 'stephanie' },
    }),
  ]
  const model = buildDashboard(input)
  const row = allRows(model).find((entry) => entry.id === 'fx-live-wait')
  assert.equal(row.active, true)
  assert.deepEqual(row.stuckReasons, [])
  assert.deepEqual(stuckIds(model), [])
})

test('a convoy is never its own row, whatever its type, synthetic flag or number of tracked items', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-cv-typed', {
      issue_type: 'convoy',
      title: 'Release train',
      dependencies: tracks('fx-cv-typed', 'fx-a'),
    }),
    urgent('fx-cv-empty', { title: '', metadata: { 'gc.synthetic': 'true' } }),
    urgent('fx-cv-two', {
      title: 'input convoy for two',
      metadata: { 'gc.synthetic': 'true' },
      dependencies: tracks('fx-cv-two', 'fx-b', 'fx-c'),
    }),
    urgent('fx-cv-lost', {
      issue_type: 'convoy',
      dependencies: tracks('fx-cv-lost', 'fx-missing'),
    }),
  ]
  input.linked = ['fx-a', 'fx-b', 'fx-c'].map((id) => urgent(id))
  const model = buildDashboard(input)
  const ids = allRows(model).map((row) => row.id)
  for (const convoy of ['fx-cv-typed', 'fx-cv-empty', 'fx-cv-two', 'fx-cv-lost'])
    assert.ok(!ids.includes(convoy), convoy)
  assert.deepEqual(stuckIds(model).sort(), ['fx-a', 'fx-b', 'fx-c'])
  assert.ok(!stuckIds(model).includes('fx-missing'))
  assert.ok(allRows(model).every((row) => row.title !== '' || row.unread))
})

test("a convoy row is selected and shown on the tracked item's own priority", () => {
  const input = fresh()
  input.linked = [
    urgent('fx-cv-p2', {
      priority: 2,
      metadata: { 'gc.synthetic': 'true' },
      dependencies: tracks('fx-cv-p2', 'fx-p1-target'),
    }),
    urgent('fx-cv-p1', {
      priority: 1,
      metadata: { 'gc.synthetic': 'true' },
      dependencies: tracks('fx-cv-p1', 'fx-p3-target'),
    }),
    urgent('fx-cv-p0', {
      priority: 0,
      issue_type: 'convoy',
      dependencies: tracks('fx-cv-p0', 'fx-p1-other'),
    }),
    urgent('fx-p3-target', { priority: 3 }),
  ]
  input.ancestors = [urgent('fx-p1-target'), urgent('fx-p1-other')]
  const model = buildDashboard(input)
  const rows = allRows(model)
  assert.deepEqual(rows.map((row) => row.id).sort(), ['fx-p1-other', 'fx-p1-target'])
  assert.deepEqual(
    rows.map((row) => row.priority),
    [1, 1],
  )
})

test('a newer comment counts as movement: age is the later of the update and the newest comment', () => {
  const input = fresh()
  input.urgent = [urgent('fx-commented'), urgent('fx-silent'), urgent('fx-old-comment')]
  input.commentedAt = {
    's#fx-commented': '2026-10-29T11:30:00Z',
    's#fx-old-comment': '2026-10-20T00:00:00Z',
  }
  const model = buildDashboard(input)
  assert.deepEqual(stuckIds(model).sort(), ['fx-old-comment', 'fx-silent'])
  const row = allRows(model).find((entry) => entry.id === 'fx-commented')
  assert.equal(row.updatedAt, '2026-10-29T11:30:00Z')
  assert.equal(
    allRows(model).find((entry) => entry.id === 'fx-old-comment').updatedAt,
    '2026-10-28T08:00:00Z',
  )
})

test('comment reads go to stuck rows only, one show per store, capped, and fail open', () => {
  const rows = [
    { id: 'a', store: '/r1' },
    { id: 'b', store: '/r2' },
    { id: 'c', store: '/r1' },
    { id: 'u' },
  ]
  const requests = loader.commentRequests(rows)
  assert.deepEqual(
    requests.map((request) => request.args),
    [
      ['-C', '/r1', 'show', 'a', 'c', '--json', '--include-comments'],
      ['-C', '/r2', 'show', 'b', '--json', '--include-comments'],
    ],
  )
  assert.ok(
    requests.every(
      (request) => request.key === 'comments' && request.store.path === request.args[1],
    ),
  )
  const many = Array.from({ length: loader.COMMENT_CAP + 7 }, (_, i) => ({
    id: `m${i}`,
    store: '/r',
  }))
  assert.equal(loader.commentRequests(many)[0].args.length - 5, loader.COMMENT_CAP)
  assert.deepEqual(loader.commentRequests([]), [])
  const times = loader.commentTimes([
    {
      key: 'comments',
      store: { path: '/r1' },
      value: [
        {
          id: 'a',
          comments: [
            { created_at: '2026-10-29T10:00:00Z' },
            { created_at: '2026-10-29T11:00:00Z' },
            { created_at: 'never' },
          ],
        },
        { id: 'c', comments: [] },
        { id: 'd', comments: 'oops' },
        null,
      ],
    },
    { key: 'comments', store: { path: '/r2' }, error: 'timed out' },
  ])
  assert.deepEqual(times, { '/r1#a': '2026-10-29T11:00:00Z' })
})

test('a blocked urgent item is read and can be stuck; a deferred one stays out', () => {
  assert.deepEqual(loader.urgentArgs('/rig').slice(6, 8), [
    '--status',
    'open,in_progress,blocked',
  ])
  const input = fresh()
  input.urgent = [urgent('fx-blocked', { status: 'blocked' })]
  input.linked = [urgent('fx-deferred', { status: 'deferred' })]
  const model = buildDashboard(input)
  assert.deepEqual(stuckIds(model), ['fx-blocked'])
  assert.equal(model.stuck.items[0].state, 'blocked')
  assert.ok(!allRows(model).some((row) => row.id === 'fx-deferred'))
})

test('a bead a live worker session runs, named by gc.session_name, is active and not stuck', () => {
  const input = fresh()
  input.urgent = [
    urgent('fx-pool-open', { metadata: { 'gc.session_name': 'fx-worker-a' } }),
    urgent('fx-pool-claimed', {
      status: 'in_progress',
      assignee: 'omni-experiments/worker',
      metadata: { 'gc.session_name': 'fx-worker-b' },
    }),
    urgent('fx-pool-gone', { metadata: { 'gc.session_name': 'fx-worker-dead' } }),
  ]
  const model = buildDashboard(input)
  assert.deepEqual(stuckIds(model), ['fx-pool-gone'])
  const active = allRows(model)
    .filter((row) => row.active)
    .map((row) => row.id)
    .sort()
  assert.deepEqual(active, ['fx-pool-claimed', 'fx-pool-open'])
  const sessions = model.activeNow
    .flatMap((group) => group.items)
    .filter((item) => item.bead?.id?.startsWith('fx-pool'))
  assert.deepEqual(sessions.map((item) => [item.session, item.bead.id]).sort(), [
    ['fx-worker-a', 'fx-pool-open'],
    ['fx-worker-b', 'fx-pool-claimed'],
  ])
})

const stalePage = require('./stale-page.js')
const HOUR_MS = 3600000
const isCommentRead = (args) => args.includes('--include-comments')
const stuckRowIds = (document) => [...document.querySelectorAll('section')]
  .filter((node) => node.querySelector('h2')?.textContent.startsWith('Stuck'))
  .flatMap((node) => [...node.querySelectorAll('li')].map((row) => row.title).filter(Boolean))

const commentPage = (t, comments) => {
  const live = stalePage.livePage(t)
  const work = { id: 'wk-1', title: 'Index rebuild', status: 'open', priority: 1, assignee: 'lead-a',
    updated_at: new Date(live.clock - 3 * HOUR_MS).toISOString(), metadata: { 'proj.id': 'pj-1' } }
  live.linked = () => [work]
  const window = live.document.defaultView
  const base = window.bdRead
  live.commentOptions = []
  window.bdRead = async (scope, args, options) => {
    if (!isCommentRead(args)) return base(scope, args, options)
    live.commentOptions.push(options)
    live.bdCalls.push([...args])
    return comments(args)
  }
  return live
}

test('a refresh reads comments for stuck rows only, and a fresh comment takes the row out of Stuck', async (t) => {
  const live = commentPage(t, (args) => args.slice(3, -2).map((id) => ({ id,
    comments: [{ created_at: new Date(Date.parse(stalePage.EARLY) - 600000).toISOString(), text: 'still on it' }] })))
  await live.load()
  assert.deepEqual(live.bdCalls.filter(isCommentRead), [['-C', '/rigs/lead', 'show', 'wk-1', '--json', '--include-comments']])
  assert.ok(live.commentOptions[0].deadline <= live.clock + loader.COMMENT_READ_MS)
  assert.deepEqual(stuckRowIds(live.document), [])
})

test('a failed comment read leaves the row stuck on its update time and the page renders', async (t) => {
  const live = commentPage(t, () => { throw new Error('show timed out') })
  await live.load()
  assert.deepEqual(stuckRowIds(live.document), ['wk-1'])
})
