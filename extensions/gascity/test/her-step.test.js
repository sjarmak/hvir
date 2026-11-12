const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { STEP_LABEL, stepArgs, herSteps } = require('../needs-model.js')
const { buildDashboard } = require('../projects-model.js')
const loader = require('../projects-load.js')
const fixture = require('./fixtures/projects-dashboard.json')

const decision = (id, fields = {}) => ({
  id,
  title: `Decision ${id}`,
  status: 'open',
  labels: ['needs/stephanie', STEP_LABEL],
  store: '/rigs/decisions',
  ...fields,
})

const withStep = () => {
  const input = structuredClone(fixture)
  const target = input.decisions.find((bead) => bead.id === 'fx-ask-answered')
  target.labels = [...target.labels, STEP_LABEL]
  target.metadata = { ...target.metadata, 'gc.her_step': '  open the sheet and share it  ',
    'gc.scope': 'omni-evals', 'gc.waiting_on': 'stephanie' }
  return input
}

const render = (input, method) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js']) window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const opened = []
  window.projectsRender[method](buildDashboard(input), root, {
    onOpenBead: (id, store) => opened.push([id, store]),
  })
  return { dom, root, opened }
}

test('the step label is its own label and has its own read of the decisions rig', () => {
  assert.equal(STEP_LABEL, 'needs/stephanie-step')
  assert.deepEqual(stepArgs('/srv/dec'), [
    '-C', '/srv/dec', 'list', '--json', '--flat', '--no-pager', '--status', 'open',
    '--label', 'needs/stephanie-step', '-n', '0',
  ])
  const reads = loader.storeRequests([{ name: 'decisions', path: '/rigs/decisions' }])
    .filter((request) => request.key === 'herSteps')
  assert.deepEqual(reads.map((request) => request.args), [stepArgs('/rigs/decisions')])
})

test('a failed step read warns in the section and leaves every project card complete', (t) => {
  const store = { name: 'decisions', path: '/rigs/decisions' }
  const input = withStep()
  const { payload } = loader.assemblePayload({ now: input.now,
    reads: [{ store, key: 'herSteps', error: 'step query failed' }] })
  assert.deepEqual(payload.unread, ['herSteps'])
  const merged = { ...input, unread: payload.unread, herSteps: payload.herSteps }
  const model = buildDashboard(merged)
  assert.equal(model.stepsUnread, true)
  assert.deepEqual(model.cards, buildDashboard(withStep()).cards)
  const { dom, root } = render(merged, 'renderDashboard')
  t.after(() => dom.window.close())
  assert.match(root.firstElementChild.textContent, /Your next step/)
  assert.match(root.firstElementChild.textContent, /Some steps could not be read/)
})

test('a step-only bead from the step read reaches the section once', () => {
  const only = decision('dec-only', { labels: [STEP_LABEL], metadata: { 'gc.her_step': 'Do it' } })
  const model = buildDashboard({ ...structuredClone(fixture), herSteps: [only],
    decisions: [...fixture.decisions, only] })
  assert.deepEqual(model.herSteps.map((entry) => entry.id), ['dec-only'])
})

test('herSteps keeps open step-labelled beads, answered or not, with her step and scope', () => {
  const steps = herSteps([
    decision('dec-1', { metadata: { 'gc.her_step': ' run the login ', 'gc.scope': 'omni', 'gc.answered': '2026-11-09' } }),
    decision('dec-2', { metadata: { 'gc.her_step': 'pull the branch' } }),
    decision('dec-3', { status: 'closed', metadata: { 'gc.her_step': 'done already' } }),
    decision('dec-4', { labels: ['needs/stephanie'], metadata: { 'gc.her_step': 'not labelled' } }),
    decision('dec-5', { labels: ['Needs/Stephanie-Step'], metadata: { 'gc.her_step': 7 } }),
    decision('dec-6', { labels: undefined }),
  ])
  assert.deepEqual(steps, [
    { id: 'dec-1', title: 'Decision dec-1', store: '/rigs/decisions', step: 'run the login', scope: 'omni', cardText: '', description: '' },
    { id: 'dec-2', title: 'Decision dec-2', store: '/rigs/decisions', step: 'pull the branch', scope: '', cardText: '', description: '' },
    { id: 'dec-5', title: 'Decision dec-5', store: '/rigs/decisions', step: '', scope: '', cardText: '', description: '' },
  ])
})

test('the dashboard puts her next step first and keeps the Needs you section as it was', (t) => {
  const { dom, root, opened } = render(withStep(), 'renderDashboard')
  t.after(() => dom.window.close())
  const first = root.firstElementChild
  assert.match(first.textContent, /Your next step/)
  assert.match(first.textContent, /omni-evals/)
  assert.match(first.textContent, /open the sheet and share it/)
  assert.match(first.textContent, /fx-ask-answered/)
  first.querySelector('button').click()
  assert.equal(opened[0][0], 'fx-ask-answered')
  assert.match(first.nextElementSibling.textContent, /Needs you/)
})

test('the rail shows her next step above Needs you', (t) => {
  const { dom, root } = render(withStep(), 'renderNav')
  t.after(() => dom.window.close())
  const headings = [...root.querySelectorAll('h2, h3')].map((node) => node.textContent)
  assert.ok(headings.indexOf('Your next step') >= 0)
  assert.ok(headings.indexOf('Your next step') < headings.indexOf('Needs you'))
  assert.match(root.textContent, /open the sheet and share it/)
})

test('with no step waiting the section is absent', (t) => {
  const { dom, root } = render(structuredClone(fixture), 'renderDashboard')
  t.after(() => dom.window.close())
  assert.doesNotMatch(root.textContent, /Your next step/)
})

test('a labelled bead with no step written still shows, naming the gap without sentinel text', (t) => {
  const input = withStep()
  delete input.decisions.find((bead) => bead.id === 'fx-ask-answered').metadata['gc.her_step']
  const { dom, root } = render(input, 'renderDashboard')
  t.after(() => dom.window.close())
  assert.match(root.firstElementChild.textContent, /No step written: /)
  for (const title of [undefined, null, false]) {
    const bare = { id: 'dec-x', title, status: 'open', labels: [STEP_LABEL], store: '/rigs/decisions', metadata: {} }
    assert.equal(herSteps([bare])[0].title, '')
    const shown = render({ ...structuredClone(fixture), herSteps: [bare] }, 'renderNav')
    const section = shown.root.querySelector('.projects-step')
    assert.equal(section.textContent.includes('No step written: dec-x'), true)
    assert.doesNotMatch(section.textContent, /undefined|null|false/)
    shown.dom.window.close()
  }
})

test('card text leads a step row and folds the step, id and raw description into details', (t) => {
  const input = withStep()
  const target = input.decisions.find((bead) => bead.id === 'fx-ask-answered')
  target.description = 'Raw notes for the agent'
  target.metadata = { ...target.metadata, 'gc.card_text': '  Open the shared sheet so the agents can start. Only you have access.  ' }
  assert.equal(buildDashboard(input).herSteps[0].cardText, 'Open the shared sheet so the agents can start. Only you have access.')
  const { dom, root, opened } = render(input, 'renderDashboard')
  t.after(() => dom.window.close())
  const row = root.querySelector('.projects-step')
  assert.equal(row.querySelector('.projects-card-text').textContent, 'Open the shared sheet so the agents can start. Only you have access.')
  const details = row.querySelector('details')
  assert.equal(details.open, false)
  assert.match(details.textContent, /open the sheet and share it.*fx-ask-answered.*Raw notes for the agent/s)
  details.querySelector('button').click()
  assert.equal(opened[0][0], 'fx-ask-answered')
})

test('a step row without card text renders as before, with no details', (t) => {
  const { dom, root } = render(withStep(), 'renderDashboard')
  t.after(() => dom.window.close())
  const row = root.querySelector('.projects-step')
  assert.equal(row.querySelector('details'), null)
  assert.equal(row.querySelector('.projects-card-text'), null)
})
