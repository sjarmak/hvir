const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { buildDashboard } = require('../projects-model.js')

const NOW = '2026-10-31T16:30:00.000Z'
const project = (meta = {}) => ({
  id: 'p',
  title: 'Eval bias check',
  status: 'open',
  labels: ['city-project'],
  store: '/hq',
  metadata: {
    'proj.lead': 'omni-evals-pl',
    'proj.state': 'paused',
    'proj.now': 'Waiting for the rerun.',
    'proj.next_action': 'Rerun after the fix lands.',
    'proj.waiting_on': 'w1, stephanie',
    'proj.receipt_at': '2026-10-31T15:30Z',
    'proj.updated_at': '2026-10-31T16:29Z',
    ...meta,
  },
})
const work = (id, title) => ({
  id,
  title,
  status: 'open',
  store: '/hq',
  metadata: { 'proj.id': 'p' },
})
const owed = (id, meta = {}) => ({
  id,
  title: `Title of ${id}`,
  status: 'open',
  store: '/decisions',
  labels: ['needs/stephanie'],
  metadata: {
    'gc.project': 'p',
    'gc.answered': '2026-10-30',
    'gc.owner': 'omni-pl',
    ...meta,
  },
})

const pageFor = (t, input = {}) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(NOW)
  for (const file of ['view.js', 'card-words.js', 'projects-render.js'])
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const card = buildDashboard({
    now: NOW,
    sessions: [],
    projects: [project()],
    ...input,
  }).cards.flatMap((g) => g.cards)[0]
  const root = window.document.querySelector('main')
  window.projectsRender.renderProject(card, root, {})
  return root
}
const lines = (root) =>
  Object.fromEntries(
    [...root.querySelectorAll('.projects-where li')].map((li) => {
      const label = li.querySelector('.projects-where-label').textContent
      return [label, li.textContent.slice(label.length)]
    }),
  )

test('the page opens with a where-it-stands block before the counters', (t) => {
  const root = pageFor(t, { linked: [work('w1', 'Fix the rater')] })
  const block = root.querySelector('.projects-where')
  assert.ok(block)
  assert.equal(root.querySelector('h1').parentElement.nextElementSibling, block)
  assert.ok(block.compareDocumentPosition(root.querySelector('.projects-glance')) & 4)
  const found = lines(root)
  assert.deepEqual(Object.keys(found), [
    'Now',
    'Next',
    'Waiting on',
    'Last real progress',
  ])
  assert.equal(found.Now, 'Waiting for the rerun.')
  assert.equal(found.Next, 'Rerun after the fix lands.')
  assert.match(found['Waiting on'], /Fix the rater.*w1.*you/s)
  assert.doesNotMatch(found['Waiting on'], /stephanie/)
  assert.match(found['Last real progress'], /1h ago|hour/)
})

test('empty fields are omitted and no waits reads nothing', (t) => {
  const root = pageFor(t, {
    projects: [
      project({
        'proj.next_action': '',
        'proj.waiting_on': 'none',
        'proj.receipt_at': '',
      }),
    ],
  })
  const found = lines(root)
  assert.deepEqual(Object.keys(found), ['Now', 'Waiting on'])
  assert.equal(found['Waiting on'], 'nothing')
})

test('one state word: the lead state chip in the block, a disagreement line, no State tile or lead-record line', (t) => {
  const root = pageFor(t, {
    decisions: [owed('d1')],
    linked: [work('w1', 'Fix the rater')],
  })
  assert.equal(root.querySelector('.projects-where .projects-chip').textContent, 'paused')
  assert.match(
    root.querySelector('.projects-where-disagree').textContent,
    /The board and the lead's record disagree: board says agents owe, record says paused/,
  )
  assert.ok(
    ![...root.querySelectorAll('.projects-tile')].some((n) =>
      /^State/.test(n.textContent),
    ),
  )
  assert.doesNotMatch(root.textContent, /Lead's record says/)
})

test('no disagreement line when the board agrees', (t) => {
  const started = { ...work('w1', 'x'), status: 'in_progress', assignee: 'omni-pl' }
  const root = pageFor(t, {
    projects: [project({ 'proj.state': 'moving' })],
    inProgress: [started],
  })
  assert.equal(root.querySelector('.projects-where-disagree'), null)
})

test('answered decisions show title, date and owner, with delivery notes collapsed', (t) => {
  const note = 're-record answer with dec-answer --replace'
  const root = pageFor(t, {
    decisions: [owed('d1', { 'gc.delivery_status': note, 'gc.delivery_bead': 'w9' })],
  })
  const item = root.querySelector('.projects-in-delivery li')
  const details = item.querySelector('details')
  const summary = item.textContent.replace(details.textContent, '')
  assert.match(summary, /Title of d1.*2026-10-30.*omni-pl/s)
  assert.doesNotMatch(summary, /dec-answer|w9/)
  assert.equal(details.open, false)
  assert.equal(details.querySelector('summary').textContent, 'Delivery notes')
  assert.match(details.textContent, /re-record answer with dec-answer --replace/)
})

test('each answered decision shows its next checkpoint, or says none is recorded', (t) => {
  const root = pageFor(t, {
    decisions: [owed('d1', { 'gc.readout_due': '2099-12-24' }), owed('d2')],
  })
  const [first, second] = [...root.querySelectorAll('.projects-in-delivery li')]
  assert.match(first.textContent, /omni-pl · next 2099-12-24/)
  assert.match(second.textContent, /omni-pl · no next checkpoint/)
})

test('dated lead text shows its dates with when it was written, on the page and the overview card', (t) => {
  const now = 'Stack 2 boots 2026-11-01T09:00Z, then the rerun on Nov 3rd.'
  const root = pageFor(t, { projects: [project({ 'proj.now': now, 'proj.content_at': '2026-10-31T14:30Z' })] })
  assert.equal(lines(root).Now, `${now} · written 2h ago`)
  assert.doesNotMatch(root.textContent, /date removed/)
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  dom.window.Date.now = () => Date.parse(NOW)
  for (const file of ['view.js', 'card-words.js', 'projects-render.js'])
    dom.window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const overview = dom.window.document.querySelector('main')
  dom.window.projectsRender.renderDashboard(buildDashboard({ now: NOW, sessions: [],
    projects: [project({ 'proj.now': now, 'proj.content_at': '2026-10-31T14:30Z' })] }), overview, {})
  const strip = overview.querySelector('.projects-strip')
  assert.match(strip.textContent, /Stack 2 boots 2026-11-01T09:00Z, then the rerun on Nov 3rd\.\s*· written 2h ago/)
})

test('lead text without a recorded write time shows no written note', (t) => {
  const root = pageFor(t)
  assert.equal(lines(root).Now, 'Waiting for the rerun.')
})
