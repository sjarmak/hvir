const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')

const OLD = '2026-10-27T12:00:00Z'

const bead = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  status: 'open',
  priority: 1,
  labels: [],
  store: 's',
  updated_at: OLD,
  metadata: {},
  ...extra,
})

const renderStuck = (t, urgent, linked = []) => {
  const input = structuredClone(fixture)
  input.urgent = urgent
  input.linked = [...(input.linked ?? []), ...linked]
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  dom.window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'card-words.js', 'projects-render.js'])
    dom.window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = dom.window.document.querySelector('main')
  const opened = []
  dom.window.projectsRender.renderDashboard(buildDashboard(input), root, {
    onOpenBead: (...args) => opened.push(args),
  })
  const stuck = [...root.querySelectorAll(':scope > section')].find((node) =>
    node.querySelector('h2').textContent.startsWith('Stuck'),
  )
  const row = (id) => {
    const found = [...stuck.querySelectorAll('li')].find((node) => node.title === id)
    assert.ok(found, `${id} is in Stuck`)
    return found
  }
  const line = (id) => row(id).querySelector('.projects-status-line').textContent
  const flags = (id) =>
    [...row(id).querySelectorAll('.projects-flag')].map((node) => node.textContent)
  return { row, line, flags, opened }
}

test('a Stuck row names the assignee as its owner', (t) => {
  const { line } = renderStuck(t, [bead('fx-x-owner', { assignee: 'omni-pl' })])
  assert.match(line('fx-x-owner'), /^Owner: the Omni code lead · /)
})

test('a Stuck row with no assignee and a routed pool reads unclaimed by the pool since its last update', (t) => {
  const { line, flags } = renderStuck(t, [
    bead('fx-x-pool', { metadata: { 'gc.execution_routed_to': 'rig/rig-worker' } }),
  ])
  assert.match(
    line('fx-x-pool'),
    /Waiting on: unclaimed by rig\/rig-worker since 2 days ago/,
  )
  assert.ok(!flags('fx-x-pool').includes('no wait recorded'))
})

test('a Stuck row shows gc.waiting_on as what it waits on', (t) => {
  const { line, flags } = renderStuck(t, [
    bead('fx-x-wait', { metadata: { 'gc.waiting_on': 'omni-pl' } }),
  ])
  assert.match(line('fx-x-wait'), /Waiting on: the Omni code lead for 2 days/)
  assert.ok(!flags('fx-x-wait').includes('no wait recorded'))
})

test('a blank gc.waiting_on falls back to gc.blocked_on', (t) => {
  const { line, flags } = renderStuck(t, [
    bead('fx-x-blocked', {
      metadata: { 'gc.waiting_on': '  ', 'gc.blocked_on': 'omni-evals-pl' },
    }),
    bead('fx-x-absent', { metadata: { 'gc.blocked_on': 'omni-pl' } }),
    bead('fx-x-both', {
      metadata: { 'gc.waiting_on': 'omni-pl', 'gc.blocked_on': 'omni-evals-pl' },
    }),
  ])
  assert.match(line('fx-x-blocked'), /Waiting on: the evals lead for 2 days/)
  assert.match(line('fx-x-absent'), /Waiting on: the Omni code lead for 2 days/)
  assert.match(line('fx-x-both'), /Waiting on: the Omni code lead for 2 days/)
  assert.doesNotMatch(line('fx-x-both'), /evals lead/)
  assert.ok(!flags('fx-x-blocked').includes('no wait recorded'))
})

test('a Stuck row with neither a wait nor a route is flagged no wait recorded', (t) => {
  const { flags } = renderStuck(t, [bead('fx-x-none', { assignee: 'omni-pl' })])
  assert.ok(flags('fx-x-none').includes('no wait recorded'))
})

test('a folded convoy row shows the tracked bead owner and wait, not the convoy ones, and still opens the tracked bead', (t) => {
  const { row, line, opened } = renderStuck(
    t,
    [
      bead('fx-x-convoy', {
        title: 'input convoy for fx-x-real',
        issue_type: 'convoy',
        assignee: 'mayor',
        metadata: { 'gc.synthetic': 'true', 'gc.waiting_on': 'stephanie' },
        dependencies: [
          { issue_id: 'fx-x-convoy', depends_on_id: 'fx-x-real', type: 'tracks' },
        ],
      }),
    ],
    [
      bead('fx-x-real', {
        title: 'The real work',
        assignee: 'omni-evals-pl',
        metadata: { 'gc.blocked_on': 'omni-pl' },
      }),
    ],
  )
  assert.match(
    line('fx-x-real'),
    /^Owner: the evals lead · Waiting on: the Omni code lead for 2 days/,
  )
  assert.doesNotMatch(row('fx-x-real').textContent, /the mayor|you|input convoy/)
  row('fx-x-real').querySelector('button').click()
  assert.equal(opened[0][0], 'fx-x-real')
})

const RECENT = '2026-10-29T09:00:00Z'

test('an old blocked_on wait in free text stays Stuck and is flagged likely broken', (t) => {
  const { line, flags, row } = renderStuck(t, [
    bead('fx-x-generic', { metadata: { 'gc.blocked_on': 'database recovery' } }),
  ])
  assert.match(line('fx-x-generic'), /Waiting on: database recovery for 2 days — likely broken/)
  assert.ok(flags('fx-x-generic').includes('likely broken'))
  assert.match(row('fx-x-generic').textContent, /Stuck because: waiting on a recorded wait for over a day/)
})

test('an old blocked_on wait on an unloaded bead stays Stuck and is flagged likely broken', (t) => {
  const { flags } = renderStuck(t, [
    bead('fx-x-unloaded', { metadata: { 'gc.blocked_on': 'fx-unloaded-blocker' } }),
  ])
  assert.ok(flags('fx-x-unloaded').includes('likely broken'))
})

test('a recent free-text blocked_on wait shows under Waiting, not Stuck', () => {
  const input = structuredClone(fixture)
  input.urgent = [bead('fx-x-recent', { updated_at: RECENT, metadata: { 'gc.blocked_on': 'database recovery' } })]
  const model = buildDashboard(input)
  assert.deepEqual(model.stuck.items.map((r) => r.id), [])
  const waiting = model.waiting.items.find((r) => r.id === 'fx-x-recent')
  assert.ok(waiting)
  assert.equal(waiting.likelyBroken, false)
})

test('a recognized wait kind over a day keeps its kind and broken-wait reason', (t) => {
  const input = structuredClone(fixture)
  input.urgent = [bead('fx-x-known', { metadata: { 'gc.blocked_on': 'stephanie' } })]
  const found = buildDashboard(input).stuck.items.find((r) => r.id === 'fx-x-known')
  assert.equal(found.waitKind, 'her')
  assert.deepEqual(found.stuckReasons, ['broken-wait'])
  const { row } = renderStuck(t, input.urgent)
  assert.match(row('fx-x-known').textContent, /Stuck because: waiting on you for over a day/)
})
