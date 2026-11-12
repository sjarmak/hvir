const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const { textBlocks, detailSections, pageOf } = require('../bead-page.js')

const NOW = '2026-11-12T21:00:00Z'
const issue = (extra = {}) => ({ id: 'om-x1', title: 'Raw title om-x1', status: 'in_progress', priority: 1,
  assignee: 'omni-evals-pl', updated_at: '2026-11-12T19:00:00Z', description: '', metadata: {}, labels: [], ...extra })

test('raw notes become paragraphs, headings and bullet lists', () => {
  assert.deepEqual(textBlocks('## Goal\nShip the driver\nwith fakes only.\n\n- one\n* two\n3. three\n\nLast line.'), [
    { kind: 'heading', text: 'Goal' },
    { kind: 'para', text: 'Ship the driver with fakes only.' },
    { kind: 'list', items: ['one', 'two', 'three'] },
    { kind: 'para', text: 'Last line.' },
  ])
  assert.deepEqual(textBlocks(''), [])
  assert.deepEqual(textBlocks(undefined), [])
})

test('a card summary splits into labelled sections, carrying unlabelled lines into the one before', () => {
  assert.deepEqual(detailSections('What it is: A driver.\nWhere it stands: Built.\nmore words\n\nNeeds you: Nothing.'), [
    { heading: 'What it is', text: 'A driver.' },
    { heading: 'Where it stands', text: 'Built. more words' },
    { heading: 'Needs you', text: 'Nothing.' },
  ])
})

test('the page leads with the card line, then owner, status, wait, the summary sections and the original notes', () => {
  const page = pageOf(issue({ description: 'raw body', metadata: { 'gc.waiting_on': 'stephanie' },
    comments: [
      { author: 'omni-evals-pl', text: 'first', created_at: '2026-11-11T10:00:00Z' },
      { author: 'mayor', text: 'second\n\n- point', created_at: '2026-11-12T20:30:00Z' },
    ] }),
  { text: 'The driver is built and waits on your go.', details: 'What it is: A driver.\nWhat happens next: You say go.' }, NOW)
  assert.equal(page.lead, 'The driver is built and waits on your go.')
  assert.deepEqual(page.facts, [
    { label: 'Owner', text: 'the evals lead' },
    { label: 'Status', text: 'In progress, last moved 2 hours ago' },
    { label: 'Waiting on', text: 'you for 2 hours' },
  ])
  assert.deepEqual(page.sections.map((entry) => entry.heading), ['What it is', 'What happens next'])
  assert.deepEqual(page.original, [{ kind: 'para', text: 'raw body' }])
  assert.deepEqual(page.comments.map((entry) => [entry.who, entry.when]), [
    ['the mayor', '2026-11-12 20:30Z (30 minutes ago)'], ['the evals lead', '2026-11-11 10:00Z (1 day ago)']])
  assert.deepEqual(page.comments[0].blocks, [{ kind: 'para', text: 'second' }, { kind: 'list', items: ['point'] }])
})

test('without a summary the description itself is the readable body and there are no original notes', () => {
  const page = pageOf(issue({ status: 'open', assignee: '', description: 'Line one.\n\n- a', metadata: {} }), {}, NOW)
  assert.equal(page.lead, '')
  assert.deepEqual(page.facts.map((entry) => entry.text), ['Nobody assigned', 'Open, last moved 2 hours ago',
    'nothing recorded — it last moved 2 hours ago'])
  assert.deepEqual(page.sections, [{ heading: 'Notes', blocks: [{ kind: 'para', text: 'Line one.' }, { kind: 'list', items: ['a'] }] }])
  assert.equal(page.original, null)
  assert.deepEqual(page.comments, [])
})

test('a wait on a decision for over a day reads as likely broken', () => {
  const page = pageOf(issue({ updated_at: '2026-11-10T21:00:00Z', metadata: { 'gc.waiting_on': 'dec-abc1' } }), {}, NOW)
  assert.equal(page.facts[2].text, 'you (a decision) for 2 days — likely broken')
})

test('the page renders bead text as text only, never as markup', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  for (const file of ['view.js', 'needs-model.js', 'card-words.js', 'bead-page.js'])
    dom.window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const hostile = '<img src=x onerror="window.hit=1"> **bold**'
  const page = dom.window.beadPage.pageOf(issue({ description: hostile,
    comments: [{ author: 'x', text: hostile, created_at: NOW }] }),
  { text: hostile, details: `What it is: ${hostile}` }, NOW)
  const root = dom.window.document.querySelector('main')
  root.replaceChildren(...dom.window.beadPage.renderPage(page), dom.window.beadPage.renderOriginal(page))
  assert.equal(root.querySelector('img'), null)
  assert.equal(dom.window.hit, undefined)
  assert.ok(root.querySelector('.bead-lead').textContent.includes('<img'))
  const headings = [...root.querySelectorAll('h2')].map((node) => node.textContent)
  assert.deepEqual(headings, ['Owner', 'Status', 'Waiting on', 'What it is', 'Recent comments'])
  const original = root.querySelector('details.bead-original')
  assert.equal(original.open, false)
  assert.equal(original.querySelector('summary').textContent, 'Original notes')
  assert.equal(root.lastElementChild, original)
})

test('there are no original notes to fold when the page has none', (t) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  for (const file of ['view.js', 'card-words.js', 'bead-page.js']) dom.window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  assert.equal(dom.window.beadPage.renderOriginal(pageOf(issue(), {}, NOW)), null)
})
