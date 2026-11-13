const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const load = () => {
  const window = {}
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'answer-state.js'), 'utf8'), { window })
  return window.answerState
}
const SHA = 'a'.repeat(64)

test('the key joins workspace, decision and card hash', () => {
  const state = load()
  assert.notEqual(state.keyOf('w1', 'dec-a', SHA), state.keyOf('w2', 'dec-a', SHA))
  assert.notEqual(state.keyOf('w1', 'dec-a', SHA), state.keyOf('w1', 'dec-b', SHA))
  assert.notEqual(state.keyOf('w1', 'dec-a', SHA), state.keyOf('w1', 'dec-a', 'b'.repeat(64)))
})

test('begin admits one submission per key until it finishes with a retryable result', () => {
  const state = load()
  const key = state.keyOf('w1', 'dec-a', SHA)
  assert.equal(state.begin(key), true)
  assert.equal(state.begin(key), false)
  assert.equal(state.get(key).phase, 'pending')
  state.finish(key, { exitCode: 2, line: 'Refused.' })
  assert.equal(state.get(key).phase, 'idle')
  assert.equal(state.begin(key), true)
})

test('finish classifies results: 0 and 1 lock, 2 and not sent retry, unknown and odd exits lock as unknown', () => {
  const state = load()
  const phaseOf = (result) => {
    const key = state.keyOf('w1', `dec-${JSON.stringify(result).length}`, SHA)
    state.begin(key)
    return state.finish(key, result).phase
  }
  assert.equal(phaseOf({ exitCode: 0, line: 'x' }), 'done')
  assert.equal(phaseOf({ exitCode: 1, line: 'xx' }), 'warning')
  assert.equal(phaseOf({ exitCode: 2, line: 'xxx' }), 'idle')
  assert.equal(phaseOf({ exitCode: 2, notSent: true, line: 'x' }), 'idle')
  assert.equal(phaseOf({ unknown: true, line: 'xxxxxx' }), 'unknown')
  assert.equal(phaseOf({ exitCode: 7, line: 'xxxxxxxx' }), 'unknown')
})

test('listeners hear every change for their key and a disconnected one is dropped', () => {
  const state = load()
  const key = state.keyOf('w1', 'dec-a', SHA)
  const heard = []
  state.subscribe(key, (entry) => (heard.push(entry.phase), true))
  state.subscribe(key, () => false)
  state.begin(key)
  state.finish(key, { exitCode: 0, line: 'ok' })
  state.begin(state.keyOf('w1', 'dec-other', SHA))
  assert.deepEqual(heard, ['pending', 'done'])
  heard.length = 0
  state.begin(key)
  assert.deepEqual(heard, [])
})

const read = (key, overrides = {}) => ({
  listedKeys: new Set([key]), openKeys: new Set([key]), readStartedAt: 200, complete: true, ...overrides,
})
const unknownAt100 = (state) => {
  const key = state.keyOf('w1', 'dec-a', SHA)
  state.begin(key)
  state.finish(key, { unknown: true, line: 'u' }, 100)
  return key
}

test('an unknown outcome is freed only by a fresh complete read listing the decision open and unanswered', () => {
  const state = load()
  const key = unknownAt100(state)
  state.reconcile('w1', read(key))
  assert.equal(state.get(key).phase, 'idle')
})

test('an unknown outcome survives a read that began before or at its completion', () => {
  const state = load()
  const key = unknownAt100(state)
  state.reconcile('w1', read(key, { readStartedAt: 50 }))
  state.reconcile('w1', read(key, { readStartedAt: 100 }))
  assert.equal(state.get(key).phase, 'unknown')
})

test('an unknown outcome survives incomplete, failed and inconclusive reads', () => {
  const state = load()
  const key = unknownAt100(state)
  state.reconcile('w1', read(key, { complete: false }))
  state.reconcile('w1', read(key, { complete: false, listedKeys: new Set(), openKeys: new Set() }))
  assert.equal(state.get(key).phase, 'unknown')
})

test('an unknown outcome survives a read listing the decision as answered but still waiting', () => {
  const state = load()
  const key = unknownAt100(state)
  state.reconcile('w1', read(key, { openKeys: new Set() }))
  assert.equal(state.get(key).phase, 'unknown')
})

test('an unknown outcome survives a complete read that no longer lists the decision', () => {
  const state = load()
  const key = unknownAt100(state)
  state.reconcile('w1', read(key, { listedKeys: new Set(), openKeys: new Set() }))
  assert.equal(state.get(key).phase, 'unknown')
})

test('reconcile never frees a pending submission and drops settled entries only on a fresh complete read that does not list them', () => {
  const state = load()
  const pending = state.keyOf('w1', 'dec-a', SHA)
  const done = state.keyOf('w1', 'dec-b', SHA)
  const other = state.keyOf('w2', 'dec-c', SHA)
  for (const key of [pending, done, other]) state.begin(key)
  state.finish(done, { exitCode: 0, line: 'ok' }, 1)
  state.finish(other, { exitCode: 0, line: 'ok' }, 1)
  const empty = { listedKeys: new Set(), openKeys: new Set(), readStartedAt: 1000, complete: true }
  state.reconcile('w1', { ...empty, complete: false })
  assert.equal(state.get(done).phase, 'done')
  state.reconcile('w1', { ...empty, readStartedAt: 0 })
  assert.equal(state.get(done).phase, 'done')
  state.reconcile('w1', empty)
  assert.equal(state.get(pending).phase, 'pending')
  assert.equal(state.get(done).phase, 'idle')
  assert.equal(state.get(done).result, undefined)
  assert.equal(state.get(other).phase, 'done')
})

test('subscribing the same listener twice delivers each change once', () => {
  const state = load()
  const key = state.keyOf('w1', 'dec-a', SHA)
  let heard = 0
  const listener = () => (heard += 1, true)
  state.subscribe(key, listener)
  state.subscribe(key, listener)
  state.begin(key)
  assert.equal(heard, 1)
})

test('a card subscribes before its submission key exists and follows reconciliation', () => {
  const state = load()
  const key = state.keyOf('w1', 'dec-a', SHA)
  const card = JSON.stringify(['w1', 'dec-a', 'Choose', '', [{ letter: 'a', text: 'Yes' }]])
  const heard = []
  state.subscribe(card, (entry) => (heard.push(entry.phase), true))
  assert.equal(state.get(card).phase, 'idle')
  state.begin(key, card)
  assert.equal(state.get(card), state.get(key))
  state.finish(key, { unknown: true, line: 'u' }, 100)
  assert.equal(state.get(card), state.get(key))
  state.reconcile('w1', read(key))
  assert.equal(state.get(card).phase, 'idle')
  assert.deepEqual(heard, ['pending', 'unknown', 'idle'])
})
