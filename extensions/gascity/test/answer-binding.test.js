const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const needsModel = require('../needs-model.js')

const SHA = 'c'.repeat(64)
const workspace = { id: 'ws-1', host: 'local' }
const HELLO = { kind: 'hello', contract: '1.0', capabilities: ['connector.execute', 'connector.action-binding'] }
const UNBOUND = { kind: 'hello', contract: '1.0', capabilities: ['connector.execute'] }
const INPUT = { decId: 'dec-a1', letter: 'a', cardSha256: SHA }
const settled = () => new Promise((resolve) => setTimeout(resolve, 5))

const load = ({ onExecute } = {}) => {
  const listeners = new Set()
  const sent = []
  const timers = []
  const respond = (message, ok, value) =>
    queueMicrotask(() => [...listeners].forEach((listener) => listener({ kind: 'result', id: message.id, ok, value })))
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      if (message.kind !== 'request') return
      if (message.capability === 'connector.execute') return onExecute?.(message, (value) => respond(message, true, value))
      if (message.capability === 'connector.output')
        return respond(message, true, message.input.release ? {} : { data: 'Recorded.\n', nextOffset: null })
    },
  }
  const window = {
    needsModel,
    hvirExtension: bridge,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  }
  for (const file of ['host.js', 'answer.js']) vm.runInNewContext(readFileSync(join(__dirname, '..', file), 'utf8'), { window })
  const deliver = (message) => [...listeners].forEach((listener) => listener(message))
  deliver(HELLO)
  const replies = []
  window.answerAction.listen({ onMessage: bridge.onMessage, send: (message) => replies.push(message) })
  const answer = (id, input = INPUT) =>
    deliver({ kind: 'action', invocation: { id, action: 'answer-decision', input, context: { workspace } } })
  const executes = () => sent.filter((message) => message.capability === 'connector.execute')
  return { window, sent, timers, deliver, replies, answer, executes }
}

const pending = () => {
  const releases = []
  return { releases, onExecute: (message, finish) => releases.push(() => finish({ outcome: 'completed', receipt: 'r', code: 0, truncated: false })) }
}

test('an answer queued for admission is not sent when the binding drops before it is admitted', async () => {
  const gate = pending()
  const state = load(gate)
  for (const n of [1, 2, 3]) state.answer(`busy-${n}`, { ...INPUT, decId: `dec-b${n}` })
  await settled()
  assert.equal(state.executes().length, 3)
  state.answer('queued', { ...INPUT, decId: 'dec-q1' })
  await settled()
  assert.equal(state.executes().length, 3)
  state.deliver(UNBOUND)
  gate.releases.splice(0).forEach((release) => release())
  await settled()
  assert.equal(state.executes().length, 3)
  const reply = state.replies.find((message) => message.id === 'queued')
  assert.equal(reply.value.notSent, true)
  assert.equal(reply.value.exitCode, 2)
  assert.match(reply.value.line, /cannot bind answers/)
})

test('an answer waiting in the pacing window is not sent when the binding drops before the window opens', async () => {
  const state = load()
  for (let n = 0; n < 25; n += 1) void state.window.host.request('connector.status', { workspace: 'w' })
  await settled()
  state.answer('paced')
  await settled()
  assert.equal(state.executes().length, 0)
  assert.equal(state.timers.length, 1)
  state.deliver(UNBOUND)
  const deadline = Date.now() + 3000
  while (!state.replies.some((message) => message.id === 'paced') && Date.now() < deadline) {
    state.timers.splice(0).forEach((timer) => timer.fn())
    await settled()
  }
  assert.equal(state.executes().length, 0)
  const reply = state.replies.find((message) => message.id === 'paced')
  assert.equal(reply.value.notSent, true)
})

test('a retry after a capacity refusal is not sent when the binding dropped during the retry delay', async () => {
  const state = load({ onExecute: (message, finish) => finish({ outcome: 'unavailable', reason: 'capacity', retryAfterMs: 50 }) })
  state.answer('retried')
  await settled()
  assert.equal(state.executes().length, 1)
  assert.equal(state.timers.length, 1)
  state.deliver(UNBOUND)
  state.timers.splice(0).forEach((timer) => timer.fn())
  await settled()
  assert.equal(state.executes().length, 1)
  const reply = state.replies.find((message) => message.id === 'retried')
  assert.equal(reply.value.notSent, true)
  assert.equal(reply.value.exitCode, 2)
})

test('a revoked guest sends nothing from answers still queued', async () => {
  const gate = pending()
  const state = load(gate)
  for (const n of [1, 2, 3]) state.answer(`busy-${n}`, { ...INPUT, decId: `dec-b${n}` })
  await settled()
  state.answer('queued', { ...INPUT, decId: 'dec-q1' })
  await settled()
  state.deliver({ kind: 'revoked' })
  gate.releases.splice(0).forEach((release) => release())
  await settled()
  assert.equal(state.executes().length, 3)
  assert.equal(state.replies.find((message) => message.id === 'queued').value.notSent, true)
})

test('a bound answer still goes out through admission and pacing', async () => {
  const gate = pending()
  const state = load(gate)
  state.answer('plain')
  await settled()
  assert.equal(state.executes().length, 1)
  gate.releases.splice(0).forEach((release) => release())
  await settled()
  assert.equal(state.replies.find((message) => message.id === 'plain').value.exitCode, 0)
})
