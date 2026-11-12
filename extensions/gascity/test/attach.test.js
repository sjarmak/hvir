const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

function load(host) {
  const window = { host }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'attach.js'), 'utf8'), { window })
  return window.attachAction
}

const WORKSPACE = { id: 'w1' }
const plain = (value) => JSON.parse(JSON.stringify(value))

test('a valid name hands gc session attach <name> to the terminal with the action id', async () => {
  const calls = []
  const host = {
    terminal: async (...args) => (calls.push(args), { outcome: 'handed-off' }),
  }
  const value = await load(host).attach(
    host,
    WORKSPACE,
    { name: 'omni-evals-desk' },
    'act-1',
  )
  assert.deepEqual(plain(calls), [
    ['gc', WORKSPACE, ['session', 'attach', 'omni-evals-desk'], 'act-1'],
  ])
  assert.match(value.line, /omni-evals-desk/)
})

test('invalid names throw before any host call', async () => {
  let called = 0
  const host = { terminal: async () => (called += 1) }
  const api = load(host)
  for (const name of [
    undefined,
    42,
    '',
    '-x',
    '.x',
    'a b',
    'a/b',
    'a;b',
    '../x',
    'a'.repeat(65),
  ])
    await assert.rejects(api.attach(host, WORKSPACE, { name }, 'act-1'), /session name/)
  await assert.rejects(api.attach(host, WORKSPACE, undefined, 'act-1'), /session name/)
  assert.equal(called, 0)
})

test('a declined confirmation is reported, not thrown', async () => {
  const host = { terminal: async () => ({ outcome: 'not-started', reason: 'declined' }) }
  const value = await load(host).attach(host, WORKSPACE, { name: 'desk' }, 'act-1')
  assert.equal(value.line, 'Terminal not started: declined')
})

test('the listener answers only attach-session actions, replying with the invocation id', async () => {
  const sent = []
  let listener
  const host = { terminal: async () => ({ outcome: 'handed-off' }) }
  const window = { host }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'attach.js'), 'utf8'), { window })
  window.attachAction.listen({
    onMessage: (fn) => (listener = fn),
    send: (message) => sent.push(message),
  })
  listener({ kind: 'action', invocation: { id: 'i-0', action: 'answer-decision' } })
  listener({
    kind: 'action',
    invocation: {
      id: 'i-1',
      action: 'attach-session',
      input: { name: 'desk' },
      context: { workspace: WORKSPACE },
    },
  })
  listener({
    kind: 'action',
    invocation: {
      id: 'i-2',
      action: 'attach-session',
      input: { name: '../x' },
      context: { workspace: WORKSPACE },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    sent
      .map((message) => [message.id, message.value?.line, message.error])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [
      ['i-1', 'Opened a terminal attached to desk.', undefined],
      ['i-2', undefined, 'name must be a session name'],
    ],
  )
})

test('a row with an attach name invokes the action; any other row opens the session', async () => {
  const requests = []
  const host = { request: async (...args) => (requests.push(args), { line: 'ok' }) }
  const api = load(host)
  const opened = []
  const lines = []
  await api.routeRow(
    { dataset: { attach: 'desk' } },
    (row) => opened.push(row),
    (result) => lines.push(result.line),
  )
  assert.deepEqual(plain(requests), [
    ['actions.invoke', { action: 'attach-session', input: { name: 'desk' } }],
  ])
  assert.deepEqual(lines, ['ok'])
  assert.deepEqual(opened, [])
  const live = { dataset: { id: 'gc-1' } }
  await api.routeRow(
    live,
    (row) => opened.push(row),
    () => lines.push('x'),
  )
  assert.deepEqual(opened, [live])
  assert.equal(requests.length, 1)
})

test('a seat owner opens through attach-seat, and a bad seat name is refused before any request', async () => {
  const requests = []
  const host = { request: async (...args) => (requests.push(args), { line: 'ok' }) }
  const api = load(host)
  assert.deepEqual(plain(await api.attachSeat('omni-pl')), { line: 'ok' })
  for (const name of ['', 'a b', '../x', 42]) await assert.rejects(api.attachSeat(name), /session name/)
  assert.deepEqual(plain(requests), [['actions.invoke', { action: 'attach-seat', input: { name: 'omni-pl' } }]])
})

test('the projects listener runs gc session attach for attach-seat only, and refuses a bad name', async () => {
  const sent = []
  const calls = []
  let listener
  const host = { terminal: async (...args) => (calls.push(args), { outcome: 'handed-off' }) }
  const window = { host }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'attach.js'), 'utf8'), { window })
  window.attachAction.listen({ onMessage: (fn) => (listener = fn), send: (message) => sent.push(message) }, window.attachAction.SEAT_ACTION)
  const invocation = (id, action, name) => ({ kind: 'action', invocation: { id, action, input: { name }, context: { workspace: WORKSPACE } } })
  listener(invocation('i-0', 'attach-session', 'desk'))
  listener(invocation('i-1', 'attach-seat', 'omni-pl'))
  listener(invocation('i-2', 'attach-seat', 'a;b'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(plain(calls), [['gc', WORKSPACE, ['session', 'attach', 'omni-pl'], 'i-1']])
  assert.deepEqual(sent.map((message) => [message.id, message.value?.line, message.error]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['i-1', 'Opened a terminal attached to omni-pl.', undefined],
    ['i-2', undefined, 'name must be a session name'],
  ])
})
