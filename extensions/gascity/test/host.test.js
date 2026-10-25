const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

/** Load host.js against a fake bridge that answers connector.status per workspace and connector.execute with `executed`. */
function loadHost(statusByWorkspace, executed) {
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      const value =
        message.capability === 'connector.status'
          ? statusByWorkspace[message.input?.workspace]
          : message.capability === 'connector.execute'
            ? executed
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

function loadBridge(answer) {
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      Promise.resolve(answer(message)).then(
        (value) =>
          listeners.forEach((listener) =>
            listener({ kind: 'result', id: message.id, ok: true, value }),
          ),
        (error) =>
          listeners.forEach((listener) =>
            listener({ kind: 'result', id: message.id, ok: false, error: error.message }),
          ),
      )
    },
  }
  const window = { hvirExtension: bridge, setTimeout }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window })
  return { host: window.host, sent }
}

function completed(receipt) {
  return { outcome: 'completed', receipt, code: 0, truncated: false }
}

function outputFor(message, stdoutByReceipt) {
  if (message.input.release) return {}
  const data =
    message.input.stream === 'stdout' ? stdoutByReceipt[message.input.receipt] : ''
  return { data, nextOffset: null }
}

const executes = (sent) =>
  sent.filter((message) => message.capability === 'connector.execute')
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

const LOCAL = { id: 'ws-local', host: 'local' }
const REMOTE = { id: 'ws-remote', host: 'devbox' }

test('availability asks hvir about the given workspace and reports its rows', async () => {
  const { host, sent } = loadHost({
    'ws-local': [{ connector: 'gc', availability: 'supported', host: 'local' }],
    'ws-remote': [
      {
        connector: 'gc',
        availability: 'unavailable',
        reason: 'unavailable',
        host: 'devbox',
      },
    ],
  })
  assert.equal((await host.availability({ workspace: LOCAL })).gc, 'supported')
  assert.equal((await host.availability({ workspace: REMOTE })).gc, 'unavailable')
  // host.js runs in its own vm realm, so compare its messages by value.
  assert.equal(
    JSON.stringify(sent.map((message) => message.input)),
    JSON.stringify([{ workspace: 'ws-local' }, { workspace: 'ws-remote' }]),
  )
})

test('status is cached per workspace, not shared across workspaces', async () => {
  const { host, sent } = loadHost({
    'ws-local': [{ connector: 'gc', availability: 'supported', host: 'local' }],
    'ws-remote': [{ connector: 'gc', availability: 'supported', host: 'devbox' }],
  })
  await host.availability({ workspace: LOCAL })
  await host.availability({ workspace: LOCAL })
  await host.availability({ workspace: REMOTE })
  assert.equal(
    sent.filter((message) => message.capability === 'connector.status').length,
    2,
  )
})

test('runs at most three connector executions at once and queues the rest', async () => {
  const pending = []
  let receipts = 0
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return new Promise((resolve) =>
        pending.push(() => resolve(completed(`r${++receipts}`))),
      )
    return outputFor(
      message,
      Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`r${n}`, `{"n":${n}}`])),
    )
  })
  const runs = [1, 2, 3, 4, 5].map(() => host.run('gc', LOCAL, ['status']))
  await settle()
  assert.equal(executes(sent).length, 3)
  pending.splice(0).forEach((start) => start())
  await settle()
  assert.equal(executes(sent).length, 5)
  pending.splice(0).forEach((start) => start())
  assert.deepEqual(
    (await Promise.all(runs)).map((value) => value.n).sort(),
    [1, 2, 3, 4, 5],
  )
})

test("a capacity refusal is retried after hvir's retryAfterMs until it completes", async () => {
  let refusals = 0
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return refusals++ < 2
        ? { outcome: 'unavailable', reason: 'capacity', retryAfterMs: 1 }
        : completed('r1')
    return outputFor(message, { r1: '{"ok":true}' })
  })
  assert.equal(JSON.stringify(await host.run('gc', LOCAL, ['status'])), '{"ok":true}')
  assert.equal(executes(sent).length, 3)
})

test('a capacity refusal that never clears is reported after the retries run out', async () => {
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return { outcome: 'unavailable', reason: 'capacity', retryAfterMs: 1 }
    return outputFor(message, {})
  })
  await assert.rejects(host.run('gc', LOCAL, ['status']), (error) => {
    assert.equal(error.reason, 'capacity')
    assert.equal(error.message, 'gc did not run: capacity')
    return true
  })
  assert.equal(executes(sent).length, 7)
})

test('other refusals are not retried', async () => {
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return { outcome: 'unavailable', reason: 'disconnected' }
    return outputFor(message, {})
  })
  await assert.rejects(host.run('gc', LOCAL, ['status']), /did not run: disconnected/)
  assert.equal(executes(sent).length, 1)
})

for (const [reason, transient] of [
  ['frequency', true],
  ['capacity', true],
  ['unapproved', false],
]) {
  test(`a run hvir did not start for ${reason} is ${transient ? '' : 'not '}transient`, async () => {
    const { host } = loadHost(
      {},
      { outcome: 'not-started', reason, host: 'local', retryAfterMs: 1 },
    )
    await assert.rejects(host.run('gc', LOCAL, ['--version']), (error) => {
      assert.equal(error.reason, reason)
      assert.equal(error.transient, transient)
      return true
    })
  })
}
