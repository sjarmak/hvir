const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

function loadView(load) {
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
  window.startView({ load })
  return { context: (context) => deliver({ kind: 'context', context }) }
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
