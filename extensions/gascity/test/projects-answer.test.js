const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { webcrypto } = require('node:crypto')
const { JSDOM } = require('jsdom')
const { buildDashboard } = require('../projects-model.js')
const fixture = require('./fixtures/projects-dashboard.json')

const CHOICES = JSON.stringify([
  { letter: 'a', text: 'Keep traces for thirty days' },
  { letter: 'b', text: `Keep traces for a full year, then archive everything that is older than that to cold storage` },
])
const TITLE = 'Choose a trace retention window'
const BODY = 'Pick a window.\nThen we apply it.'

const withAsk = (metadata, description = BODY) => {
  const data = structuredClone(fixture)
  const ask = data.decisions[0]
  ask.description = description
  ask.metadata = { ...ask.metadata, ...metadata }
  return data
}

const page = (t, { metadata = { 'gc.options': CHOICES }, description, onAnswer, answerable = true } = {}) => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom
  window.Date.now = () => Date.parse(fixture.now)
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true })
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder, configurable: true })
  for (const file of ['view.js', 'needs-model.js', 'answer-state.js', 'card-words.js', 'projects-render.js'])
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const calls = []
  const options = answerable
    ? { workspaceId: 'ws-1', onAnswer: onAnswer ?? (async (...args) => (calls.push(args), { exitCode: 0, line: 'Recorded.' })) }
    : {}
  const model = buildDashboard(withAsk(metadata, description))
  window.projectsRender.renderDashboard(model, root, options)
  const rerender = () => window.projectsRender.renderDashboard(model, root, options)
  const present = () => {
    const extra = window.document.createElement('main')
    window.document.body.append(extra)
    window.projectsRender.renderDashboard(model, extra, options)
    return extra
  }
  const card = () => root.querySelector('section li')
  const buttons = () => [...card().querySelectorAll('.projects-answer > button')]
  const confirm = () => card().querySelector('.projects-confirm')
  const press = (label) => [...card().querySelectorAll('button')].find((node) => node.textContent === label).click()
  return { window, root, calls, card, buttons, confirm, press, rerender, present, options }
}
const until = async (condition, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met before the timeout')
    await new Promise((resolve) => setImmediate(resolve))
  }
}
const outcomeNote = (state) => () => state.card().querySelector('.projects-answer-outcome p')
const allDisabled = (state) => () => state.buttons().every((node) => node.disabled)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('the owner and session link render below the answer buttons', (t) => {
  const state = page(t, { metadata: { 'gc.options': CHOICES, 'gc.owner': 'omni-pl' } })
  const answer = state.card().querySelector('.projects-answer')
  const owner = [...state.card().querySelectorAll('div')].find((node) => node.textContent.startsWith('Owner: Verity'))
  assert.ok(answer)
  assert.ok(owner)
  assert.ok(answer.compareDocumentPosition(owner) & state.window.Node.DOCUMENT_POSITION_FOLLOWING)
})

test('a needs-you card with valid options shows one button per option labelled letter and text', (t) => {
  const { buttons } = page(t)
  assert.deepEqual(buttons().map((node) => node.textContent.slice(0, 40)), [
    'a: Keep traces for thirty days',
    'b: Keep traces for a full year, then arc',
  ])
  assert.ok(buttons()[1].textContent.length <= 51)
  assert.ok(buttons()[1].textContent.endsWith('…'))
  assert.equal(buttons()[1].title, JSON.parse(CHOICES)[1].text)
})

test('without gc.options, with a bad list, or without onAnswer the card has no answer buttons', (t) => {
  for (const state of [
    page(t, { metadata: {} }),
    page(t, { metadata: { 'gc.options': 'nope' } }),
    page(t, { metadata: { 'gc.options': JSON.stringify([{ letter: 'a', text: 'x' }, { letter: 'a', text: 'y' }]) } }),
    page(t, { answerable: false }),
  ]) {
    assert.equal(state.card().querySelector('.projects-answer'), null)
  }
})

test('the existing card parts are unchanged beside the buttons', (t) => {
  const { card } = page(t)
  assert.match(card().textContent, /Choose a trace retention window/)
  assert.ok(card().querySelector('.projects-refs button'))
})

test('answered and waiting-on-agents decisions never get buttons, wherever they are listed', (t) => {
  const { window, root } = page(t)
  const data = withAsk({ 'gc.options': CHOICES })
  for (const decision of data.decisions) decision.metadata = { ...decision.metadata, 'gc.options': CHOICES }
  window.projectsRender.renderDashboard(buildDashboard(data), root, { onAnswer: async () => ({ exitCode: 0, line: '' }) })
  const answerable = [...root.querySelectorAll('.projects-answer')].map((node) => node.closest('li').textContent)
  assert.ok(answerable.length > 0)
  assert.ok(answerable.every((text) => !text.includes('Pick a catalog accent')))
  assert.ok(answerable.some((text) => text.includes(TITLE)))
})

test('an answered decision still waiting on her is listed under Needs you but gets no answer buttons', (t) => {
  const state = page(t, { metadata: { 'gc.options': CHOICES, 'gc.answered': '2026-11-10', 'gc.waiting_on': 'stephanie' } })
  assert.match(state.card().textContent, new RegExp(TITLE))
  assert.equal(state.root.querySelectorAll('.projects-answer').length, 0)
  assert.equal(state.present().querySelectorAll('.projects-answer').length, 0)
})

test('clicking an option asks first, naming the letter, the option text and the card title', (t) => {
  const { buttons, confirm, calls } = page(t)
  buttons()[0].click()
  assert.equal(confirm().querySelector('p').textContent,
    `Record a: Keep traces for thirty days as your answer to ${TITLE}?`)
  assert.deepEqual([...confirm().querySelectorAll('button')].map((node) => node.textContent), ['Confirm', 'Cancel'])
  assert.equal(calls.length, 0)
})

test('Cancel closes the question and sends nothing', (t) => {
  const { buttons, confirm, press, calls } = page(t)
  buttons()[0].click()
  press('Cancel')
  assert.equal(confirm().children.length, 0)
  assert.equal(calls.length, 0)
})

test('Confirm sends the decision id, the letter and the SHA-256 of title, newline and description', async (t) => {
  const { buttons, press, calls } = page(t)
  buttons()[1].click()
  press('Confirm')
  await until(() => calls.length === 1)
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${TITLE}\n${BODY}`))).toString('hex')
  assert.deepEqual(calls, [['fx-ask-retention', 'b', expected]])
  assert.match(expected, /^[0-9a-f]{64}$/)
})

test('every button is disabled while the call is in flight and the question is gone after', async (t) => {
  const pending = deferred()
  let started = false
  const { card, buttons, press } = page(t, { onAnswer: () => { started = true; return pending.promise } })
  buttons()[0].click()
  press('Confirm')
  await until(() => started)
  assert.ok([...card().querySelectorAll('button')].filter((node) => node.closest('.projects-answer')).every((node) => node.disabled))
  pending.resolve({ exitCode: 2, line: 'Refused.' })
  await until(() => card().querySelector('.projects-answer-outcome p'))
  assert.ok(buttons().every((node) => !node.disabled))
})

test('exit 0 shows the line and keeps the answered card from being answered twice', async (t) => {
  const { card, buttons, press } = page(t, { onAnswer: async () => ({ exitCode: 0, line: 'Recorded a for fx-ask-retention.' }) })
  buttons()[0].click()
  press('Confirm')
  await until(() => card().querySelector('.projects-answer-outcome p'))
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.textContent, 'Recorded a for fx-ask-retention.')
  assert.equal(note.dataset.state, 'done')
  assert.ok(buttons().every((node) => node.disabled))
})

test('exit 2 shows the line as an error and keeps the buttons usable', async (t) => {
  const { card, buttons, press } = page(t, { onAnswer: async () => ({ exitCode: 2, line: 'The card changed since you looked.' }) })
  buttons()[0].click()
  press('Confirm')
  await until(() => card().querySelector('.projects-answer-outcome p'))
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.textContent, 'The card changed since you looked.')
  assert.equal(note.dataset.state, 'error')
  assert.ok(note.classList.contains('projects-error'))
  assert.ok(buttons().every((node) => !node.disabled))
})

test('exit 1 shows the line as a warning and the answer is not offered again', async (t) => {
  const { card, buttons, press } = page(t, { onAnswer: async () => ({ exitCode: 1, line: 'Recorded, but the owner mail failed.' }) })
  buttons()[0].click()
  press('Confirm')
  await until(() => card().querySelector('.projects-answer-outcome p'))
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.dataset.state, 'warning')
  assert.ok(note.classList.contains('projects-warning'))
  assert.ok(buttons().every((node) => node.disabled))
})

test('an unexpected exit code or a thrown error is an unknown completion and keeps the buttons off', async (t) => {
  for (const onAnswer of [async () => ({ exitCode: 7, line: 'Odd.' }), async () => { throw new Error('actions.invoke refused') }]) {
    const { card, buttons, press } = page(t, { onAnswer })
    buttons()[0].click()
    press('Confirm')
    await until(() => card().querySelector('.projects-answer-outcome p'))
    assert.equal(card().querySelector('.projects-answer-outcome p').dataset.state, 'warning')
    assert.ok(buttons().every((node) => node.disabled))
  }
})

test('a card whose text cannot be fingerprinted sends nothing and says so as an error', async (t) => {
  const { buttons, press, calls, card } = page(t, { description: 5 })
  buttons()[0].click()
  press('Confirm')
  await until(() => card().querySelector('.projects-answer-outcome p'))
  assert.equal(calls.length, 0)
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.dataset.state, 'error')
  assert.match(note.textContent, /No answer was sent: This card cannot be fingerprinted/)
})

const UNKNOWN = { unknown: true, line: 'Completion unknown; check the decision before answering again' }

const submit = async (state, index = 0, done = outcomeNote(state)) => {
  state.buttons()[index].click()
  state.press('Confirm')
  await until(done)
}

test('a refresh while a submission is pending keeps every button disabled and the count at one', async (t) => {
  const pending = deferred()
  const state = page(t, { onAnswer: (...args) => (state.calls.push(args), pending.promise) })
  await submit(state, 0, () => state.calls.length === 1)
  state.rerender()
  await until(allDisabled(state))
  assert.equal(state.buttons().length, 2)
  state.buttons()[0].click()
  state.window.document.querySelectorAll('.projects-confirm button').forEach((node) => node.click())
  assert.equal(state.window.document.querySelectorAll('.projects-confirm button').length, 0)
  assert.equal(state.calls.length, 1)
})

test('the completion of a submission started before a refresh lands on the card that is shown now', async (t) => {
  const pending = deferred()
  let started = false
  const state = page(t, { onAnswer: () => { started = true; return pending.promise } })
  await submit(state, 0, () => started)
  const detached = state.card()
  state.rerender()
  await until(allDisabled(state))
  pending.resolve({ exitCode: 0, line: 'Recorded a.' })
  await until(outcomeNote(state))
  assert.equal(state.card().querySelector('.projects-answer-outcome p').textContent, 'Recorded a.')
  assert.notEqual(state.card(), detached)
  assert.ok(state.buttons().every((node) => node.disabled))
})

test('two presentations of the same card submit at most once', async (t) => {
  const pending = deferred()
  const state = page(t, { onAnswer: (...args) => (state.calls.push(args), pending.promise) })
  const other = state.present()
  const click = (root, label) => [...root.querySelectorAll('button')].find((node) => node.textContent === label).click()
  const first = state.buttons()[0]
  first.click()
  click(state.root, 'Confirm')
  const second = other.querySelector('.projects-answer > button')
  second.click()
  click(other, 'Confirm')
  await until(() => state.calls.length === 1 && [...other.querySelectorAll('.projects-answer > button')].every((node) => node.disabled))
  pending.resolve({ exitCode: 0, line: 'Recorded a.' })
  await until(() => other.querySelector('.projects-answer-outcome p'))
  assert.equal(state.calls.length, 1)
  assert.equal(other.querySelector('.projects-answer-outcome p').textContent, 'Recorded a.')
})

test('a thrown error shows that completion is unknown and survives a refresh', async (t) => {
  const state = page(t, { onAnswer: async () => { throw new Error('bridge went away') } })
  await submit(state)
  assert.equal(state.card().querySelector('.projects-answer-outcome p').textContent, UNKNOWN.line)
  state.rerender()
  await until(allDisabled(state))
})

const keyFor = async (state) => {
  const sha = await state.window.needsModel.cardHash(buildDashboard(withAsk({ 'gc.options': CHOICES })).needsYou[0])
  return state.window.answerState.keyOf('ws-1', 'fx-ask-retention', sha)
}
const readOf = (key, overrides = {}) => ({
  listedKeys: new Set([key]), openKeys: new Set([key]), readStartedAt: Date.now() + 1000, complete: true, ...overrides,
})

test('an unknown outcome stays disabled until a fresh complete read lists the decision open and unanswered', async (t) => {
  const state = page(t, { onAnswer: async () => UNKNOWN })
  await submit(state)
  assert.equal(state.card().querySelector('.projects-answer-outcome p').textContent, UNKNOWN.line)
  assert.ok(state.buttons().every((node) => node.disabled))
  const key = await keyFor(state)
  const store = state.window.answerState
  for (const read of [
    readOf(key, { readStartedAt: 0 }),
    readOf(key, { complete: false }),
    readOf(key, { openKeys: new Set() }),
    readOf(key, { listedKeys: new Set(), openKeys: new Set() }),
  ]) {
    store.reconcile('ws-1', read)
    state.rerender()
    await until(allDisabled(state))
    assert.equal(store.get(key).phase, 'unknown')
  }
  store.reconcile('ws-1', readOf(key))
  state.rerender()
  await until(() => state.buttons().every((node) => !node.disabled))
})

test('a definite not-sent result and a real exit 2 both re-enable the buttons', async (t) => {
  for (const result of [{ exitCode: 2, notSent: true, line: 'hvir-answer did not run: unapproved' }, { exitCode: 2, line: 'Card changed.' }]) {
    const state = page(t, { onAnswer: async () => result })
    await submit(state)
    assert.equal(state.card().querySelector('.projects-answer-outcome p').textContent, result.line)
    assert.ok(state.buttons().every((node) => !node.disabled))
  }
})

test('a settled exit 0 stays locked across a refresh', async (t) => {
  const state = page(t, { onAnswer: async () => ({ exitCode: 0, line: 'Recorded a.' }) })
  await submit(state)
  state.rerender()
  await until(allDisabled(state))
  await until(outcomeNote(state))
  assert.equal(state.card().querySelector('.projects-answer-outcome p').textContent, 'Recorded a.')
})

for (const stage of ['confirmation', 'render']) test(`a fingerprint rejection during ${stage} is retryable`, async (t) => {
  const state = page(t)
  state.window.needsModel = { ...state.window.needsModel, cardHash: async () => { throw new Error('crypto unavailable') } }
  if (stage === 'render') state.rerender()
  else {
    state.buttons()[0].click()
    state.press('Confirm')
  }
  await until(outcomeNote(state))
  assert.equal(outcomeNote(state)().textContent, 'No answer was sent: crypto unavailable')
  assert.ok(state.buttons().every((node) => !node.disabled))
  assert.equal(state.calls.length, 0)
  state.window.needsModel = { ...state.window.needsModel, cardHash: async () => 'a'.repeat(64) }
  await submit(state, 0, () => state.calls.length === 1)
})

for (const [extra, reason] of [
  [{ context: {} }, 'This action needs a workspace'],
  [{ input: {} }, 'The answer needs a decision id, one letter and the card hash'],
  [{ id: '' }, 'An answer can only be recorded from an action'],
]) test(`the card can retry a handler refusal: ${reason}`, async (t) => {
  let state
  const onAnswer = (decId, letter, cardSha256) => new Promise((resolve, reject) => {
    const bridge = { send: (message) => message.error ? reject(new Error(message.error)) : resolve(message.value) }
    void state.window.answerAction.handle(bridge, {
      id: 'inv-1', input: { decId: 'dec-a1', letter, cardSha256 }, context: { workspace: { id: 'ws-1' } }, ...extra,
    })
  })
  state = page(t, { onAnswer })
  state.window.hvirExtension = { onMessage: (listener) => listener({ kind: 'hello', capabilities: ['connector.action-binding'] }) }
  state.window.host = { run: () => { throw new Error('unexpected dispatch') } }
  state.window.eval(readFileSync(`${__dirname}/../answer.js`, 'utf8'))
  await submit(state)
  assert.equal(outcomeNote(state)().textContent, `No answer was sent: ${reason}`)
  assert.ok(state.buttons().every((node) => !node.disabled))
})
