const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')

const html = readFileSync(`${__dirname}/../detail.html`, 'utf8')
const bodyOf = (source) => source.slice(source.indexOf('<body'), source.indexOf('</body>') + 7).replace(/<script[^>]*><\/script>/g, '')

const bead = { id: 'om-x1', title: 'Raw title', status: 'open', priority: 1, issue_type: 'task', assignee: 'omni-pl',
  updated_at: '2026-11-12T19:00:00Z', description: 'raw body', metadata: {}, labels: [],
  comments: [{ author: 'mayor', text: 'a note', created_at: '2026-11-12T20:00:00Z' }] }
const record = { id: 'om-p86nj8', metadata: {
  'gc.card_texts': JSON.stringify({ 'om-x1': 'The fix is ready for review.' }),
  'gc.card_details': JSON.stringify({ 'om-x1': 'What it is: A fix.\nNeeds you: Nothing.' }) } }

const openPage = async (t, reads, input = { id: 'om-x1', rig: '/rigs/omni' }) => {
  const dom = new JSDOM(`<!doctype html><html>${bodyOf(html)}</html>`, { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  for (const file of ['view.js', 'needs-model.js', 'card-words.js', 'wait-model.js', 'bead-page.js'])
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const calls = []
  let view
  window.startView = (options) => { view = options }
  window.bdRead = async (workspace, args) => {
    calls.push(args)
    return reads(args)
  }
  window.eval(readFileSync(`${__dirname}/../detail.js`, 'utf8'))
  await view.load({ workspace: { id: 'w' }, input })
  return { document: window.document, calls }
}

test('the bead page reads the bead with its comments and the card record, and renders the readable page', async (t) => {
  const { document, calls } = await openPage(t, (args) => args.includes('om-p86nj8') ? [record] : [bead])
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['-C', '/rigs/omni', 'show', 'om-x1', '--json', '--include-comments'], ['show', 'om-p86nj8', '--json']])
  assert.equal(document.getElementById('title').textContent, 'Raw title')
  assert.equal(document.querySelector('.bead-lead').textContent, 'The fix is ready for review.')
  const headings = [...document.querySelectorAll('#page h2')].map((node) => node.textContent)
  assert.deepEqual(headings, ['Owner', 'Status', 'Waiting on', 'What it is', 'Needs you', 'Recent comments'])
  assert.match(document.getElementById('page').textContent, /the Omni code lead/)
  const original = document.querySelector('#original details')
  assert.equal(original.querySelector('summary').textContent, 'Original notes')
  assert.match(original.textContent, /raw body/)
})

test('an unreadable card record still shows the bead, its raw notes and a warning', async (t) => {
  const { document } = await openPage(t, (args) => {
    if (args.includes('om-p86nj8')) throw new Error('record missing')
    return [bead]
  })
  assert.equal(document.getElementById('title').textContent, 'Raw title')
  assert.match(document.querySelector('.bead-warning').textContent, /could not be read/)
  assert.match(document.getElementById('page').textContent, /raw body/)
})

test('the bead page flags the same broken wait the dashboard resolved, and refuses a malformed target', async (t) => {
  const waiting = { ...bead, updated_at: '2000-01-01T00:00:00Z', metadata: { 'gc.waiting_on': 'worker-7' } }
  const target = { token: 'worker-7', agent: true, title: '' }
  const shown = await openPage(t, (args) => args.includes('om-p86nj8') ? [record] : [waiting], { id: 'om-x1', rig: '/rigs/omni', target })
  assert.match(shown.document.getElementById('page').textContent, /worker-7 for \d+ days — likely broken/)
  const refused = await openPage(t, () => [waiting], { id: 'om-x1', rig: '/rigs/omni', target: { token: '<b>', agent: 'yes' } })
  assert.equal(refused.document.getElementById('title').textContent, 'No bead selected')
  assert.deepEqual(refused.calls, [])
})
