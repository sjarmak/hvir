const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

function loadView(load, onStatus) {
  const listeners = new Set()
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: () => {},
  }
  const deliver = (message) => listeners.forEach((listener) => listener(message))
  const window = {
    hvirExtension: bridge,
    hvirUI: { bindPresentation: () => () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'view.js'), 'utf8'), { window, document: {} })
  const view = window.startView({ load, onStatus })
  return { view, context: (context) => deliver({ kind: 'context', context }) }
}

test('a load learns the view was hidden while it ran, and the next one starts clean', async () => {
  const seen = []
  let release
  const loads = []
  const page = loadView(async (context, run) => {
    loads.push(context)
    if (loads.length === 1) await new Promise((resolve) => (release = resolve))
    seen.push(run.hidden())
  })
  page.context({ visible: true, workspace: { id: 'w' } })
  page.context({ visible: false, workspace: { id: 'w' } })
  page.context({ visible: true, workspace: { id: 'w' } })
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen, [true, false])
  assert.equal(loads.length, 2)
})

test('a refresh while hvir reports the pane hidden says so and starts no load', async () => {
  const statuses = []
  let loads = 0
  const page = loadView(async () => { loads += 1 }, (text) => statuses.push(text))
  page.context({ visible: false, workspace: { id: 'w' } })
  await page.view.refresh()
  assert.deepEqual(statuses, ['hvir reports this pane as hidden; it loads when hvir shows it'])
  assert.equal(loads, 0)
})

test('a refresh during a running load starts no second load and adds no hidden notice', async () => {
  const statuses = []
  let loads = 0
  let release
  const page = loadView(async () => { loads += 1; await new Promise((resolve) => (release = resolve)) }, (text) => statuses.push(text))
  page.context({ visible: true, workspace: { id: 'w' } })
  await page.view.refresh()
  assert.equal(loads, 1)
  assert.deepEqual(statuses, [])
  release()
})

test('a load is told whether the pane is visible when it asks', async () => {
  const seen = []
  let release
  const page = loadView(async (context, run) => {
    await new Promise((resolve) => (release = resolve))
    seen.push(run.visible())
  })
  page.context({ visible: true, workspace: { id: 'w' } })
  page.context({ visible: false, workspace: { id: 'w' } })
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen, [false])
})
