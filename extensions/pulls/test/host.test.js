const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

/** Load host.js against a fake bridge that answers connector.status per workspace. */
function loadHost(statusByWorkspace) {
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      const value =
        message.capability === 'connector.status'
          ? statusByWorkspace[message.input?.workspace]
          : undefined
      queueMicrotask(() =>
        listeners.forEach((listener) =>
          listener(
            value === undefined
              ? { kind: 'result', id: message.id, ok: false, error: 'workspace required' }
              : { kind: 'result', id: message.id, ok: true, value },
          ),
        ),
      )
    },
  }
  const window = { hvirExtension: bridge, setTimeout }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window })
  return { host: window.host, sent }
}

const LOCAL = { id: 'ws-local', host: 'local' }
const REMOTE = { id: 'ws-remote', host: 'devbox' }

test('availability asks hvir about the given workspace and reports its rows', async () => {
  const { host, sent } = loadHost({
    'ws-local': [{ connector: 'gh', availability: 'supported', host: 'local' }],
    'ws-remote': [
      {
        connector: 'gh',
        availability: 'unavailable',
        reason: 'unavailable',
        host: 'devbox',
      },
    ],
  })
  assert.equal((await host.availability({ workspace: LOCAL })).gh, 'supported')
  assert.equal((await host.availability({ workspace: REMOTE })).gh, 'unavailable')
  // host.js runs in its own vm realm, so compare its messages by value.
  assert.equal(
    JSON.stringify(sent.map((message) => message.input)),
    JSON.stringify([{ workspace: 'ws-local' }, { workspace: 'ws-remote' }]),
  )
})

test('status is cached per workspace, not shared across workspaces', async () => {
  const { host, sent } = loadHost({
    'ws-local': [{ connector: 'gh', availability: 'supported', host: 'local' }],
    'ws-remote': [{ connector: 'gh', availability: 'supported', host: 'devbox' }],
  })
  await host.availability({ workspace: LOCAL })
  await host.availability({ workspace: LOCAL })
  await host.availability({ workspace: REMOTE })
  assert.equal(
    sent.filter((message) => message.capability === 'connector.status').length,
    2,
  )
})
