const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const needsModel = require('../needs-model.js')

const plain = (value) => JSON.parse(JSON.stringify(value))
const SHA = 'c'.repeat(64)
const workspace = { id: 'ws-1', host: 'local' }

const load = ({ result = { exitCode: 0, stdout: 'Recorded.\n', stderr: '' }, fail } = {}) => {
  const calls = []
  const sent = []
  const requests = []
  let deliver
  const bridge = {
    onMessage: (listener) => { deliver = listener; return () => {} },
    send: (message) => sent.push(message),
  }
  const host = {
    run: async (...args) => {
      calls.push(args)
      if (fail) throw fail
      return result
    },
    request: async (...args) => { requests.push(args); return { exitCode: 0, line: 'ok' } },
  }
  const window = { needsModel, host, hvirExtension: bridge }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'answer.js'), 'utf8'), { window })
  return { api: window.answerAction, window, calls, sent, requests, deliver: (message) => deliver(message) }
}

const invocation = (input, extra = {}) => ({
  kind: 'action',
  invocation: { id: 'inv-1', action: 'answer-decision', input, context: { workspace }, ...extra },
})
const settled = () => new Promise((resolve) => setImmediate(resolve))

test('the connector is named hvir-answer and the action answer-decision', () => {
  const { api } = load()
  assert.equal(api.CONNECTOR, 'hvir-answer')
  assert.equal(api.ACTION, 'answer-decision')
})

test('record runs hvir-answer once with the decision, letter and hash, tied to the action', async () => {
  const { api, calls } = load()
  const value = await api.record(
    { run: async (...args) => (calls.push(args), { exitCode: 0, stdout: 'Recorded b for dec-r30f.\nmore', stderr: '' }) },
    workspace, { decId: 'dec-r30f', letter: 'b', cardSha256: SHA }, 'inv-9')
  assert.equal(calls.length, 1)
  assert.deepEqual(plain(calls[0]), ['hvir-answer', workspace, ['dec-r30f', 'b', SHA], { exit: true, actionId: 'inv-9' }])
  assert.deepEqual(plain(value), { exitCode: 0, line: 'Recorded b for dec-r30f.' })
})

test('each exit code comes back with the program line, from stdout or else stderr', () => {
  const { api } = load()
  assert.deepEqual(api.outcomeLine({ exitCode: 2, stdout: '\n  Card changed.  \n', stderr: 'x' }), 'Card changed.')
  assert.equal(api.outcomeLine({ exitCode: 1, stdout: '', stderr: 'Recorded, mail failed.\n' }), 'Recorded, mail failed.')
  assert.equal(api.outcomeLine({ exitCode: 3, stdout: '', stderr: '' }), 'hvir-answer exited 3')
  assert.equal(api.outcomeLine({ exitCode: 2, stdout: 'x'.repeat(900), stderr: '' }).length, 400)
})

test('the action handler replies with the result for a valid invocation and passes its id on', async () => {
  const state = load({ result: { exitCode: 1, stdout: 'Recorded, but the mail failed.\n', stderr: '' } })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }))
  await settled()
  assert.deepEqual(plain(state.sent), [{ kind: 'action-result', id: 'inv-1', value: { exitCode: 1, line: 'Recorded, but the mail failed.' } }])
  assert.equal(state.calls[0][3].actionId, 'inv-1')
})

test('invalid input never reaches the connector', async () => {
  const state = load()
  state.api.listen(state.window.hvirExtension)
  for (const input of [
    undefined, {}, { decId: 'dec-a1', letter: 'a' },
    { decId: 'bead-1', letter: 'a', cardSha256: SHA },
    { decId: 'dec-a1', letter: 'ab', cardSha256: SHA },
    { decId: 'dec-a1', letter: 'a', cardSha256: 'F'.repeat(64) },
  ]) {
    state.deliver(invocation(input))
    await settled()
  }
  assert.equal(state.calls.length, 0)
  assert.equal(state.sent.length, 6)
  assert.ok(state.sent.every((message) => typeof message.error === 'string'))
})

test('an invocation without a workspace, or for another action, does not run the connector', async () => {
  const state = load()
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }, { context: {} }))
  state.deliver({ kind: 'action', invocation: { id: 'x', action: 'checkout-terminal', input: {}, context: { workspace } } })
  state.deliver({ kind: 'request', invocation: invocation({}).invocation })
  await settled()
  assert.equal(state.calls.length, 0)
  assert.equal(state.sent.length, 1)
  assert.match(state.sent[0].error, /workspace/)
})

test('a connector that did not run comes back as an action error', async () => {
  const state = load({ fail: new Error('hvir-answer did not run: not-approved') })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }))
  await settled()
  assert.match(state.sent[0].error, /did not run/)
})

test('answerDecision asks hvir to run the action; it does not run the connector itself', async () => {
  const state = load()
  const value = await state.api.answerDecision('dec-a1', 'a', SHA)
  assert.deepEqual(plain(state.requests), [['actions.invoke', { action: 'answer-decision', input: { decId: 'dec-a1', letter: 'a', cardSha256: SHA } }]])
  assert.equal(state.calls.length, 0)
  assert.deepEqual(plain(value), { exitCode: 0, line: 'ok' })
})

test('only the action handler in answer.js names the connector; every other script is free of it', () => {
  const fs = require('node:fs')
  const dir = join(__dirname, '..')
  const mentions = fs.readdirSync(dir).filter((name) => name.endsWith('.js'))
    .filter((name) => fs.readFileSync(join(dir, name), 'utf8').includes('hvir-answer'))
  assert.deepEqual(mentions, ['answer.js'])
  const source = fs.readFileSync(join(dir, 'answer.js'), 'utf8')
  assert.equal(source.match(/host\.run\(/g).length, 1)
  assert.match(source, /actionId/)
})

test('the project views load the invoker and only the Gas City view registers the handler', () => {
  const fs = require('node:fs')
  for (const page of ['projects.html', 'project.html'])
    assert.match(fs.readFileSync(join(__dirname, '..', page), 'utf8'), /answer\.js[\s\S]*projects-data\.js/)
  assert.match(fs.readFileSync(join(__dirname, '..', 'projects.js'), 'utf8'), /answerAction\.listen/)
  assert.doesNotMatch(fs.readFileSync(join(__dirname, '..', 'project.js'), 'utf8'), /listen/)
})

const tagged = (dispatch, message = 'hvir-answer failed') => Object.assign(new Error(message), { dispatch })

test('a run that may have been dispatched comes back as an unknown completion, not an error', async () => {
  const state = load({ fail: tagged('unknown', 'hvir-answer outcome unknown: transport') })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }))
  await settled()
  assert.equal(state.sent.length, 1)
  assert.equal(state.sent[0].error, undefined)
  assert.equal(state.sent[0].value.unknown, true)
  assert.equal(state.sent[0].value.line, 'Completion unknown; check the decision before answering again')
})

test('a definite refusal before dispatch comes back as not sent', async () => {
  const state = load({ fail: tagged('not-sent', 'hvir-answer did not run: unapproved') })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }))
  await settled()
  assert.equal(state.sent[0].value.notSent, true)
  assert.equal(state.sent[0].value.unknown, undefined)
  assert.match(state.sent[0].value.line, /did not run: unapproved/)
})

test('a real exit 2 stays a plain result, apart from not sent and unknown', async () => {
  const state = load({ result: { exitCode: 2, stdout: 'Card changed.\n', stderr: '' } })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }))
  await settled()
  assert.deepEqual(plain(state.sent[0].value), { exitCode: 2, line: 'Card changed.' })
})

test('an untagged error longer than 240 characters is cut to 240 before it is sent', async () => {
  const state = load({ fail: new Error('x'.repeat(900)) })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }))
  await settled()
  assert.equal(state.sent[0].error.length, 240)
})

test('every error the handler sends fits the 240 character bridge limit', async () => {
  const state = load({ fail: new Error('y'.repeat(900)) })
  state.api.listen(state.window.hvirExtension)
  state.deliver(invocation({ decId: 'dec-a1', letter: 'a', cardSha256: SHA }, { context: {} }))
  state.deliver(invocation({ decId: 'bad' }))
  await settled()
  assert.ok(state.sent.every((message) => message.error.length <= 240))
})

test('a second submission for the same workspace, decision and hash while one is in flight never reaches the connector', async () => {
  let release
  const state = load({ result: undefined })
  state.window.host.run = (...args) => {
    state.calls.push(args)
    return new Promise((resolve) => { release = () => resolve({ exitCode: 0, stdout: 'Recorded.\n', stderr: '' }) })
  }
  state.api.listen(state.window.hvirExtension)
  const input = { decId: 'dec-a1', letter: 'a', cardSha256: SHA }
  state.deliver({ kind: 'action', invocation: { id: 'inv-1', action: 'answer-decision', input, context: { workspace } } })
  state.deliver({ kind: 'action', invocation: { id: 'inv-2', action: 'answer-decision', input, context: { workspace } } })
  await settled()
  assert.equal(state.calls.length, 1)
  assert.equal(state.sent.length, 1)
  assert.equal(state.sent[0].id, 'inv-2')
  assert.equal(state.sent[0].value.unknown, true)
  release()
  await settled()
  assert.equal(state.sent.length, 2)
  assert.deepEqual(plain(state.sent[1].value), { exitCode: 0, line: 'Recorded.' })
})

test('after the first finishes the same key is admitted again, and other keys were never blocked', async () => {
  const state = load()
  state.api.listen(state.window.hvirExtension)
  const input = { decId: 'dec-a1', letter: 'a', cardSha256: SHA }
  state.deliver({ kind: 'action', invocation: { id: 'inv-1', action: 'answer-decision', input, context: { workspace } } })
  await settled()
  state.deliver({ kind: 'action', invocation: { id: 'inv-2', action: 'answer-decision', input, context: { workspace } } })
  state.deliver({ kind: 'action', invocation: { id: 'inv-3', action: 'answer-decision', input: { ...input, decId: 'dec-b2' }, context: { workspace } } })
  await settled()
  assert.equal(state.calls.length, 3)
})
