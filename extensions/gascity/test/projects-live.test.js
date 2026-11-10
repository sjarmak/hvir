const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')

const edit = (input, id, metadata) => {
  const bead = [...input.milestones, ...input.projects].find((entry) => entry.id === id)
  bead.metadata = { ...bead.metadata, ...metadata }
}

const mount = (change = () => {}, options = {}) => {
  const input = structuredClone(fixture)
  change(input)
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  for (const file of ['view.js', 'projects-render.js'])
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const model = buildDashboard(input)
  window.projectsRender.renderDashboard(model, root, options)
  return { dom, root, model }
}

const rowOf = (root, id) => root.querySelector(`.projects-detail li[title="${id}"]`)
const cardOf = (root, id) =>
  [...root.querySelectorAll('.projects-card')].find(
    (card) => card.querySelector('h3').title === id,
  )

test('milestone row shows the milestone state chip, one-sentence now and age', (t) => {
  const { dom, root } = mount((input) =>
    edit(input, 'fx-ms-1', {
      'proj.state': 'stuck',
      'proj.now': 'Index rebuild is running.',
      'proj.updated_at': '2026-10-29T09:00Z',
    }),
  )
  t.after(() => dom.window.close())
  const row = rowOf(root, 'fx-ms-1')
  assert.equal(row.querySelector('.projects-chip').dataset.state, 'stuck')
  assert.match(row.textContent, /Index rebuild is running\./)
  assert.match(row.textContent, /updated 3h ago/)
})

test('milestone row without the fields renders as before', (t) => {
  const { dom, root } = mount()
  t.after(() => dom.window.close())
  const row = rowOf(root, 'fx-ms-1')
  assert.equal(row.querySelector('.projects-chip').dataset.state, 'active')
  assert.doesNotMatch(row.textContent, /updated/)
})

test('changed badge shows only for a card newer than the previous look', (t) => {
  const { dom, root } = mount(() => {}, { lastLooked: '2026-10-29T09:30:00.000Z' })
  t.after(() => dom.window.close())
  assert.ok(cardOf(root, 'fx-project-1').querySelector('.projects-changed'))
  assert.equal(cardOf(root, 'fx-project-4').querySelector('.projects-changed'), null)
})

test('a newer milestone alone marks the card changed', (t) => {
  const { dom, root } = mount(
    (input) => edit(input, 'fx-ms-4', { 'proj.updated_at': '2026-10-29T11:00Z' }),
    { lastLooked: '2026-10-29T09:30:00.000Z' },
  )
  t.after(() => dom.window.close())
  assert.ok(cardOf(root, 'fx-project-4').querySelector('.projects-changed'))
})

for (const field of ['proj.state', 'proj.updated_at']) {
  for (const [label, value] of [
    ['number', 42],
    ['null', null],
    ['object', { a: 1 }],
    ['empty string', ''],
  ]) {
    test(`milestone ${field} as ${label} still renders the page`, (t) => {
      const { dom, root } = mount((input) => {
        edit(input, 'fx-ms-1', { [field]: value })
        edit(input, 'fx-ms-2', { 'proj.state': 'stuck' })
      })
      t.after(() => dom.window.close())
      const row = rowOf(root, 'fx-ms-1')
      assert.equal(row.querySelector('.projects-chip').dataset.state, 'active')
      assert.doesNotMatch(row.textContent, /updated/)
      assert.equal(
        rowOf(root, 'fx-ms-2').querySelector('.projects-chip').dataset.state,
        'stuck',
      )
    })
  }
}

test('an invalid project timestamp does not hide a newer milestone change', (t) => {
  const { dom, root } = mount(
    (input) => {
      edit(input, 'fx-project-4', { 'proj.updated_at': 'garbage' })
      edit(input, 'fx-ms-4', { 'proj.updated_at': '2026-10-29T11:00Z' })
    },
    { lastLooked: '2026-10-29T09:30:00.000Z' },
  )
  t.after(() => dom.window.close())
  assert.ok(cardOf(root, 'fx-project-4').querySelector('.projects-changed'))
})

test('all timestamps invalid gives no changed time and no badge', (t) => {
  const { dom, root, model } = mount(
    (input) => {
      edit(input, 'fx-project-4', { 'proj.updated_at': 'garbage' })
      edit(input, 'fx-ms-4', { 'proj.updated_at': 42 })
    },
    { lastLooked: '2026-10-29T09:30:00.000Z' },
  )
  t.after(() => dom.window.close())
  const card = model.cards
    .flatMap((group) => group.cards)
    .find((entry) => entry.id === 'fx-project-4')
  assert.equal(card.changedAt, null)
  assert.equal(cardOf(root, 'fx-project-4').querySelector('.projects-changed'), null)
})

test('no badge without a previous look', (t) => {
  const { dom, root } = mount(() => {}, { lastLooked: null })
  t.after(() => dom.window.close())
  assert.equal(root.querySelector('.projects-changed'), null)
})

test('summary strip carries state, now and what it waits on', (t) => {
  const { dom, root } = mount()
  t.after(() => dom.window.close())
  const strip = cardOf(root, 'fx-project-1').querySelector('.projects-strip')
  assert.equal(strip.querySelector('.projects-chip').dataset.state, 'moving')
  assert.match(strip.textContent, /Building the first searchable collection\./)
  assert.match(strip.textContent, /Waits: unverified/)
  assert.equal(strip.querySelector('.projects-waits-you'), null)
})

test('strip marks a project that waits on her decision', (t) => {
  const { dom, root, model } = mount()
  t.after(() => dom.window.close())
  const waiting = model.cards
    .flatMap((group) => group.cards)
    .find((card) => card.actionOwner.kind === 'user')
  assert.ok(waiting, 'fixture has a project waiting on her')
  const strip = cardOf(root, waiting.id).querySelector('.projects-strip')
  assert.match(strip.querySelector('.projects-waits-you').textContent, /Waits on you/)
})

test('seen store returns the previous look, records the new one, and survives broken storage', () => {
  const { projectsSeen } = (() => {
    const window = {}
    new Function(
      'window',
      'module',
      readFileSync(`${__dirname}/../projects-seen.js`, 'utf8'),
    )(window, undefined)
    return window
  })()
  const data = new Map()
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  }
  assert.equal(
    projectsSeen.visit(() => storage, '2026-10-29T10:00:00.000Z'),
    null,
  )
  assert.equal(
    projectsSeen.visit(() => storage, '2026-10-29T11:00:00.000Z'),
    '2026-10-29T10:00:00.000Z',
  )
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  assert.equal(
    projectsSeen.visit(() => broken, '2026-10-29T11:00:00.000Z'),
    null,
  )
  assert.equal(
    projectsSeen.visit(() => {
      throw new Error('blocked')
    }, '2026-10-29T11:00:00.000Z'),
    null,
  )
})
