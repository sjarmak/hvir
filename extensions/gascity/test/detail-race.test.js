const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')

const source = (file) => readFileSync(`${__dirname}/../${file}`, 'utf8')
const settle = () => new Promise((resolve) => setImmediate(resolve))
const issue = (title) => ({ id: 'om-a', title, status: 'open', priority: 1,
  issue_type: 'task', description: title, metadata: {}, labels: [], comments: [] })

async function repeatedCard(t) {
  const html = source('detail.html').replace(/<script[^>]*><\/script>/g, '')
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  const pending = []
  let listener
  window.hvirUI = { bindPresentation: () => () => {} }
  window.hvirExtension = {
    onMessage: (callback) => { listener = callback; return () => {} },
    send: () => {},
  }
  window.host = { run: async (connector, workspace, args) => {
    assert.equal(connector, 'bd')
    if (args.includes('om-p86nj8')) return []
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  } }
  for (const file of ['view.js', 'needs-model.js', 'card-words.js', 'wait-model.js', 'bead-page.js', 'detail.js'])
    window.eval(source(file))
  const open = async (id) => {
    listener({ kind: 'context', context: { visible: true, workspace: { id: 'w' }, input: { id } } })
    await settle()
  }
  for (const id of ['om-a', 'om-b', 'om-a']) await open(id)
  assert.equal(pending.length, 3)
  return { document: window.document, pending }
}

test('A to B to A ignores the first A result after the newest A finishes', async (t) => {
  const { document, pending } = await repeatedCard(t)
  pending[2].resolve([issue('Newest A')])
  await settle()
  assert.equal(document.getElementById('title').textContent, 'Newest A')
  pending[0].resolve([issue('Stale A')])
  await settle()
  assert.equal(document.getElementById('title').textContent, 'Newest A')
  assert.equal(document.getElementById('status').textContent, '')
})

test('A to B to A ignores the first A error while the newest A is pending', async (t) => {
  const { document, pending } = await repeatedCard(t)
  pending[0].reject(new Error('old A failure'))
  await settle()
  assert.equal(document.getElementById('title').textContent, 'Loading om-a…')
  pending[2].resolve([issue('Newest A')])
  await settle()
  assert.equal(document.getElementById('title').textContent, 'Newest A')
  assert.equal(document.getElementById('status').textContent, '')
})
