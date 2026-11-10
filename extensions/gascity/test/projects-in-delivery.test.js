const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { buildDashboard } = require('../projects-model.js')

const NOW = '2026-10-31T16:30:00.000Z'
const project = (meta = {}) => ({ id: 'p', title: 'Project', status: 'open', labels: ['city-project'], store: '/hq',
  metadata: { 'proj.lead': 'city-infra-pl', 'proj.state': 'moving', 'proj.now': 'Work is in flight.',
    'proj.updated_at': '2026-10-31T16:29Z', ...meta } })
const work = (id, status, meta = {}) => ({ id, title: id, status, store: '/hq', metadata: { 'proj.id': 'p', ...meta } })
const ask = (id, meta = {}, extra = {}) => ({ id, title: `Title of ${id}`, status: 'open', store: '/decisions',
  labels: ['needs/stephanie'], metadata: { 'gc.project': 'p', ...meta }, ...extra })
const owed = (id, meta = {}, extra = {}) => ask(id, { 'gc.answered': '2026-10-30', 'gc.delivery_bead': 'w9',
  'gc.owner': 'omni-pl', ...meta }, extra)

const model = (input) => buildDashboard({ now: NOW, sessions: [], projects: [project()], ...input })
const card = (input) => model(input).cards.flatMap((group) => group.cards)[0]

const faceFor = (t, input) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(NOW)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  window.projectsRender.renderDashboard(model(input), root, {})
  return root.querySelector('.projects-card-face')
}
const lines = (face) => [...face.querySelectorAll('.projects-in-delivery li')].map((item) => item.textContent)

const started = [{ ...work('w1', 'in_progress'), assignee: 'omni-pl' }]
const STATES = {
  moving: { decisions: [owed('dec-5tkr')], inProgress: started },
  'needs-you': { decisions: [owed('dec-5tkr'), ask('dec-q')], inProgress: started },
  'agents-owe': { decisions: [owed('dec-5tkr')], linked: [work('w9', 'open')] },
}

test('reproduction: a project with started work still shows its answered decision awaiting delivery', (t) => {
  const input = STATES.moving
  assert.equal(card(input).derivedState, 'moving')
  const face = faceFor(t, input)
  assert.match(face.textContent, /Title of dec-5tkr/)
})

for (const [state, input] of Object.entries(STATES)) {
  test(`${state}: derived state is kept and the in-delivery decision gets its own line`, (t) => {
    assert.equal(card(input).derivedState, state)
    const [line, ...rest] = lines(faceFor(t, input))
    assert.equal(rest.length, 0)
    assert.equal(line, 'Title of dec-5tkr · answered 2026-10-30 · delivered by w9 · omni-pl · no next checkpoint')
  })
}

test('the line carries the delivery status when a delivery task is also named, and when it is the only evidence', (t) => {
  const both = { ...STATES.moving, decisions: [owed('dec-a', { 'gc.delivery_status': 'tests running' })] }
  assert.deepEqual(lines(faceFor(t, both)), ['Title of dec-a · answered 2026-10-30 · delivered by w9 · omni-pl · no next checkpoint · status: tests running'])
  const only = { ...STATES.moving, decisions: [owed('dec-b', { 'gc.delivery_bead': '', 'gc.delivery_status': 'waiting on review' })] }
  assert.deepEqual(lines(faceFor(t, only)), ['Title of dec-b · answered 2026-10-30 · status: waiting on review · omni-pl · no next checkpoint'])
})

test('closed and unanswered decisions never appear in the in-delivery line', (t) => {
  const input = { inProgress: started, decisions: [owed('dec-c', {}, { status: 'closed' }), ask('dec-u'), owed('dec-ok')] }
  assert.deepEqual(lines(faceFor(t, input)).map((line) => line.split(' · ')[0]), ['Title of dec-ok'])
  const none = { inProgress: started, decisions: [owed('dec-c', {}, { status: 'closed' }), ask('dec-u')] }
  assert.deepEqual(lines(faceFor(t, none)), [])
})

test('a decision her step is still open on is not in delivery', (t) => {
  const herStep = owed('dec-h', { 'gc.waiting_on': 'stephanie', 'gc.her_step': 'Click Connect.' })
  assert.deepEqual(lines(faceFor(t, { inProgress: started, decisions: [herStep] })), [])
})

test('state evidence is unchanged by the new field', () => {
  const result = card(STATES['agents-owe'])
  assert.deepEqual(result.stateEvidence, ['Title of dec-5tkr · answered 2026-10-30 · delivered by w9 · omni-pl · no next checkpoint'])
  assert.deepEqual(card(STATES.moving).stateEvidence, ['w1 · omni-pl · claimed in progress · no next checkpoint'])
  assert.deepEqual(card({ projects: [project()] }).inDelivery, [])
})
