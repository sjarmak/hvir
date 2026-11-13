const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { livePage } = require('./stale-page.js')

const source = (file) => readFileSync(`${__dirname}/../${file}`, 'utf8')
const settle = () => new Promise((resolve) => setImmediate(resolve))

const cappedBridge = () => {
  const listeners = new Set()
  const sent = []
  let unsubscribed = 0
  const emit = (message) => listeners.forEach((listener) => listener(message))
  const bridge = {
    onMessage(listener) {
      if (listeners.size >= 8) throw new Error('Extension subscription limit exceeded')
      listeners.add(listener)
      return () => { unsubscribed += 1; listeners.delete(listener) }
    },
    send(message) { sent.push(message) },
  }
  for (let i = 0; i < 5; i += 1) bridge.onMessage(() => {})
  return { bridge, sent, emit, listeners, get unsubscribed() { return unsubscribed } }
}

async function checkRouting(file, order, successes) {
  const fake = cappedBridge()
  const window = { hvirExtension: fake.bridge, setTimeout }
  vm.runInNewContext(source(file), { window })
  const requests = order.map((_, i) => window.host.request('connector.output', { offset: i }))
  const results = Promise.allSettled(requests)
  await settle()
  assert.equal(fake.sent.length, order.length)
  for (const i of order) {
    const id = fake.sent[i].id
    fake.emit({ kind: 'context', id, ok: true, value: 'wrong kind' })
    fake.emit({ kind: 'result', id: `${id}-unknown`, ok: true, value: 'wrong id' })
    fake.emit({ kind: 'result', id, ok: successes[i], value: i, error: `refused ${i}` })
    fake.emit({ kind: 'result', id, ok: true, value: 'duplicate' })
  }
  const settled = await results
  settled.forEach((result, i) => {
    assert.equal(result.status, successes[i] ? 'fulfilled' : 'rejected')
    if (successes[i]) assert.equal(result.value, i)
    else assert.equal(result.reason.message, `refused ${i}`)
  })
  assert.equal(fake.listeners.size, 6)
}

async function needsPage(t) {
  const live = livePage(t)
  live.asks = [{ id: 'dec-n7pa', title: 'Choose the next step', status: 'open',
    labels: ['needs/stephanie'], metadata: { 'gc.card_text': 'Pick the next step.' } }]
  await live.load()
  const window = live.document.defaultView
  const fake = cappedBridge()
  window.hvirExtension = fake.bridge
  window.eval(source('host.js'))
  window.eval(source('view.js'))
  const card = [...live.document.querySelectorAll('li')].find((node) => node.title === 'dec-n7pa')
  return { ...live, window, fake, card, button: card.querySelector('button.projects-card-text') }
}

if (require.main === module) {
  for (const file of ['host.js', 'pr/host.js', '../pulls/host.js'])
    test(`${file} routes ten overlapping replies through one subscription`, () =>
      checkRouting(file, [9, 0, 8, 1, 7, 2, 6, 3, 5, 4], Array.from({ length: 10 }, (_, i) => i % 2 === 0)))

  test('a Needs card opens with five permanent listeners and ten requests in flight', async (t) => {
    const { window, fake, card, button } = await needsPage(t)
    const requests = Array.from({ length: 10 }, (_, offset) => window.host.request('connector.output', { offset }))
    const results = Promise.allSettled(requests)
    await settle()
    button.click()
    await settle()
    const opened = fake.sent.find((message) => message.capability === 'viewer.open-own')
    assert.ok(opened, card.textContent)
    assert.equal(opened.input.contributionId, 'bead')
    assert.equal(opened.input.input.id, 'dec-n7pa')
    fake.emit({ kind: 'result', id: opened.id, ok: true, value: { viewId: 'bead-view' } })
    for (const message of fake.sent.filter((entry) => entry.capability === 'connector.output'))
      fake.emit({ kind: 'result', id: message.id, ok: true, value: {} })
    assert.equal((await results).filter((entry) => entry.status === 'fulfilled').length, 10)
    assert.equal(fake.listeners.size, 6)
  })

  for (const [message, expected] of [
    ['Close an extension view before opening another', 'Close an extension view before opening another'],
    ['Extension subscription limit exceeded', 'Extension subscription limit exceeded'],
    ...[
      'Extension subscription limit exceeded',
      'Close an extension view before opening another',
      'This view is opening or stopped',
      'Extension view was revoked',
      'Extension view was disposed',
    ].map((text) => [`${text}: private-id-987`, text]),
    ['Unexpected refusal for private-id-987', 'hvir refused to open this page'],
  ])
    test(`a refused Needs card open shows only ${expected}: ${message}`, (t) =>
      checkRefusal(t, message, expected))

  for (const file of ['host.js', 'pr/host.js', '../pulls/host.js'])
    for (const event of ['revoked', 'pagehide'])
      test(`${file} rejects all pending and future requests on ${event}`, () => checkDisposal(file, event))

  test('an older refusal cannot overwrite a newer successful card open', async (t) => {
    const { fake, card, button } = await needsPage(t)
    button.click()
    button.click()
    await settle()
    const [older, newer] = fake.sent.filter((message) => message.capability === 'viewer.open-own')
    fake.emit({ kind: 'result', id: newer.id, ok: true, value: { viewId: 'bead-view' } })
    await settle()
    fake.emit({ kind: 'result', id: older.id, ok: false, error: 'Extension subscription limit exceeded' })
    await settle()
    const note = card.querySelector('[role="status"]')
    assert.ok(note)
    assert.equal(note.hidden, true)
    assert.equal(note.textContent, '')
  })
}

async function checkRefusal(t, message, expected) {
  const { document, fake, card, button } = await needsPage(t)
  button.click()
  await settle()
  const opened = fake.sent.find((entry) => entry.capability === 'viewer.open-own')
  assert.ok(opened)
  fake.emit({ kind: 'result', id: opened.id, ok: false, error: message })
  await settle()
  const note = card.querySelector('[role="status"]')
  assert.ok(note, card.textContent)
  assert.equal(note.textContent, expected)
  assert.equal(note.hidden, false)
  assert.ok(document.getElementById('status').textContent.includes(message))
  button.click()
  await settle()
  assert.equal(note.hidden, true)
  const retried = fake.sent.at(-1)
  fake.emit({ kind: 'result', id: retried.id, ok: true, value: { viewId: 'bead-view' } })
  await settle()
  assert.equal(note.textContent, '')
}

async function checkDisposal(file, event) {
  const fake = cappedBridge()
  const events = new EventTarget()
  const timers = []
  const window = {
    hvirExtension: fake.bridge,
    setTimeout: (callback) => timers.push(callback),
    addEventListener: events.addEventListener.bind(events),
  }
  vm.runInNewContext(source(file), { window })
  const pending = Promise.allSettled(Array.from({ length: 26 }, () => window.host.request('connector.output')))
  await settle()
  const stop = () => event === 'revoked'
    ? fake.emit({ kind: 'revoked' }) : events.dispatchEvent(new Event('pagehide'))
  stop()
  const results = await Promise.race([pending, settle().then(() => undefined)])
  assert.ok(results, 'all pending requests must settle without replies or pacing timers')
  for (const [i, result] of results.entries()) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason.message, `Extension view was ${event === 'revoked' ? 'revoked' : 'disposed'}`)
    assert.equal(result.reason.dispatch, i < 25 ? 'unknown' : 'not-sent')
  }
  assert.equal(fake.listeners.size, 5)
  assert.equal(fake.unsubscribed, 1)
  const later = Promise.allSettled([window.host.request('viewer.open-own')])
  const future = await Promise.race([later, settle().then(() => undefined)])
  assert.ok(future, 'later requests must reject before pacing')
  assert.equal(future[0].status, 'rejected')
  assert.equal(future[0].reason.dispatch, 'not-sent')
  assert.equal(future[0].reason.message, results[0].reason.message)
  const sent = fake.sent.length
  for (const message of fake.sent) fake.emit({ kind: 'result', id: message.id, ok: true })
  stop()
  for (const callback of timers) callback()
  await settle()
  assert.equal(fake.sent.length, sent)
  assert.equal(fake.unsubscribed, 1)
}

module.exports = { checkRouting, checkRefusal }
