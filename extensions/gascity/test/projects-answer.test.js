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
  for (const file of ['view.js', 'needs-model.js', 'projects-render.js'])
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const root = window.document.querySelector('main')
  const calls = []
  const options = answerable
    ? { onAnswer: onAnswer ?? (async (...args) => (calls.push(args), { exitCode: 0, line: 'Recorded.' })) }
    : {}
  const model = buildDashboard(withAsk(metadata, description))
  window.projectsRender.renderDashboard(model, root, options)
  const card = () => root.querySelector('section li')
  const buttons = () => [...card().querySelectorAll('.projects-answer > button')]
  const confirm = () => card().querySelector('.projects-confirm')
  const press = (label) => [...card().querySelectorAll('button')].find((node) => node.textContent === label).click()
  return { window, root, calls, card, buttons, confirm, press }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

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
  await settle()
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${TITLE}\n${BODY}`))).toString('hex')
  assert.deepEqual(calls, [['fx-ask-retention', 'b', expected]])
  assert.match(expected, /^[0-9a-f]{64}$/)
})

test('every button is disabled while the call is in flight and the question is gone after', async (t) => {
  const pending = deferred()
  const { card, buttons, press } = page(t, { onAnswer: () => pending.promise })
  buttons()[0].click()
  press('Confirm')
  await settle()
  assert.ok([...card().querySelectorAll('button')].filter((node) => node.closest('.projects-answer')).every((node) => node.disabled))
  pending.resolve({ exitCode: 2, line: 'Refused.' })
  await settle()
  assert.ok(buttons().every((node) => !node.disabled))
})

test('exit 0 shows the line and keeps the answered card from being answered twice', async (t) => {
  const { card, buttons, press } = page(t, { onAnswer: async () => ({ exitCode: 0, line: 'Recorded a for fx-ask-retention.' }) })
  buttons()[0].click()
  press('Confirm')
  await settle()
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.textContent, 'Recorded a for fx-ask-retention.')
  assert.equal(note.dataset.state, 'done')
  assert.ok(buttons().every((node) => node.disabled))
})

test('exit 2 shows the line as an error and keeps the buttons usable', async (t) => {
  const { card, buttons, press } = page(t, { onAnswer: async () => ({ exitCode: 2, line: 'The card changed since you looked.' }) })
  buttons()[0].click()
  press('Confirm')
  await settle()
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
  await settle()
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.dataset.state, 'warning')
  assert.ok(note.classList.contains('projects-warning'))
  assert.ok(buttons().every((node) => node.disabled))
})

test('an unexpected exit code or a thrown error shows as an error and keeps the buttons', async (t) => {
  for (const onAnswer of [async () => ({ exitCode: 7, line: 'Odd.' }), async () => { throw new Error('actions.invoke refused') }]) {
    const { card, buttons, press } = page(t, { onAnswer })
    buttons()[0].click()
    press('Confirm')
    await settle()
    assert.equal(card().querySelector('.projects-answer-outcome p').dataset.state, 'error')
    assert.ok(buttons().every((node) => !node.disabled))
  }
})

test('a card whose text cannot be fingerprinted sends nothing and says so as an error', async (t) => {
  const { buttons, press, calls, card } = page(t, { description: 5 })
  buttons()[0].click()
  press('Confirm')
  await settle()
  assert.equal(calls.length, 0)
  const note = card().querySelector('.projects-answer-outcome p')
  assert.equal(note.dataset.state, 'error')
  assert.match(note.textContent, /no answer was sent/)
})
