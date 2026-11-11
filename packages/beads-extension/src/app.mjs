import '../../../src/shared/presentation/guest-ui.js'
import { guestClient } from '../../../src/shared/extensions/guest-client.mjs'
import { readWorkspace } from './bridge.mjs'
import { buildReadSurface } from './model.mjs'
import { createRefreshController } from './refresh.mjs'
import { executeTerminalAction } from './actions.mjs'
import { focusBeadId, focusResult } from './focus.mjs'

const { document, window } = globalThis
const bridge = window.hvirExtension
const client = guestClient(bridge)
const binding = window.hvirUI.bindPresentation(bridge)
const state = document.getElementById('state')
const content = document.getElementById('content')
const sections = document.getElementById('sections')
const crew = document.getElementById('crew')
const asOf = document.getElementById('as-of')
const refresh = document.getElementById('refresh')
const create = document.getElementById('create')
const createTitle = document.getElementById('create-title')
let context = { visible: false }
let snapshot
let pendingFocus

const controller = createRefreshController({
  async refresh() {
    return buildReadSurface(await readWorkspace(client, context, snapshot))
  },
  publish(value) {
    snapshot = value
    render(value)
  },
})

client.listen((message) => {
  if (message.kind === 'context') {
    context = message.context
    pendingFocus = focusBeadId(context.input)
    controller.setVisible(context.visible)
    if (pendingFocus) controller.request()
    return
  }
  if (message.kind !== 'action') return
  const scoped = client.forAction(message.invocation)
  void executeTerminalAction(scoped, message.invocation)
    .then(
      (value) => scoped.reply(value),
      (error) => scoped.reply(undefined, error.message),
    )
    .finally(() => scoped.dispose())
})
refresh.addEventListener('click', () => controller.request())
create.addEventListener('submit', (event) => {
  event.preventDefault()
  const title = createTitle.value.trim()
  if (!title) return
  void invoke('bead-create', { title }).then((started) => {
    if (started) create.reset()
  })
})
window.addEventListener('pagehide', () => {
  controller.dispose()
  binding.dispose()
  client.dispose()
})
client.hello()

function render(value) {
  const failures = [value.beads, value.crew].filter((source) => source.state === 'error')
  state.dataset.state = failures.length ? 'error' : 'ready'
  state.textContent = failures.length
    ? failures.map((source) => source.message).join(' · ')
    : 'Current workspace snapshot'
  state.classList.toggle('beads-error', failures.length > 0)
  content.hidden = false
  sections.replaceChildren(
    ...value.beads.sections.map((section) =>
      sectionElement(section.label, section.items ?? [], section.count, beadActions),
    ),
  )
  crew.replaceChildren(
    ...value.crew.groups.map((group) =>
      sectionElement(
        group.label,
        group.members.map((member) => ({
          id: member.id,
          title: member.bead
            ? `${member.label} · ${member.bead.title}`
            : `${member.label} · ${member.state}`,
        })),
        group.members.length,
        crewActions,
      ),
    ),
  )
  const observed = Math.max(value.beads.observedAt ?? 0, value.crew.observedAt ?? 0)
  asOf.textContent = observed
    ? `As of ${new Date(observed).toLocaleTimeString()}`
    : 'No snapshot yet'
  applyFocus(value)
}

function sectionElement(label, items, count, actions) {
  const container = document.createElement('section')
  container.className = 'beads-section'
  const heading = document.createElement('h3')
  heading.textContent = `${label} · ${count}`
  container.append(heading)
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'beads-empty'
    empty.textContent = 'None'
    container.append(empty)
    return container
  }
  const list = document.createElement('ul')
  list.className = 'beads-list'
  for (const item of items) {
    const row = document.createElement('li')
    row.className = 'beads-row'
    const title = document.createElement('span')
    title.className = 'beads-row-title'
    title.textContent = item.title
    const id = document.createElement('span')
    id.className = 'beads-id'
    id.textContent = item.id
    row.dataset.beadId = item.id
    const controls = actions(item)
    row.append(title, id, controls)
    list.append(row)
  }
  container.append(list)
  return container
}

function beadActions(item) {
  const controls = document.createElement('span')
  controls.className = 'beads-row-actions'
  if (item.status !== 'in_progress')
    controls.append(actionButton('Claim', 'bead-claim', { id: item.id }))
  if (item.status !== 'closed')
    controls.append(actionButton('Close', 'bead-close', { id: item.id }))
  return controls
}

function crewActions(item) {
  const controls = document.createElement('span')
  controls.className = 'beads-row-actions'
  for (const [label, action] of [
    ['Attach', 'crew-attach'],
    ['Peek', 'crew-peek'],
    ['Reset', 'crew-reset'],
    ['Handoff', 'crew-handoff'],
  ])
    controls.append(actionButton(label, action, { target: item.id }))
  return controls
}

function actionButton(label, action, input) {
  const button = document.createElement('button')
  button.className = 'hvir-button beads-action'
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', () => void invoke(action, input))
  return button
}

async function invoke(action, input) {
  try {
    await client.request('actions.invoke', { action, input })
    return true
  } catch (error) {
    state.dataset.state = 'error'
    state.textContent = error.message
    state.classList.add('beads-error')
    return false
  }
}

function applyFocus(value) {
  if (!pendingFocus) return
  const result = focusResult({ focusBeadId: pendingFocus }, value)
  if (result.state === 'pending') return
  pendingFocus = undefined
  if (result.state === 'missing') {
    state.dataset.state = 'error'
    state.textContent = `Bead ${result.id} is no longer available in this workspace.`
    state.classList.add('beads-error')
    return
  }
  const row = [...document.querySelectorAll('[data-bead-id]')].find(
    (element) => element.dataset.beadId === result.id,
  )
  if (!row) return
  row.classList.add('beads-row-focused')
  row.tabIndex = -1
  row.focus()
  row.scrollIntoView({ block: 'center' })
}
