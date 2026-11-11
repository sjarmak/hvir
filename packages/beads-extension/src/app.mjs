import '../../../src/shared/presentation/guest-ui.js'
import { guestClient } from '../../../src/shared/extensions/guest-client.mjs'
import { readWorkspace } from './bridge.mjs'
import { buildReadSurface } from './model.mjs'
import { createRefreshController } from './refresh.mjs'

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
let context = { visible: false }
let snapshot

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
  if (message.kind !== 'context') return
  context = message.context
  controller.setVisible(context.visible)
})
refresh.addEventListener('click', () => controller.request())
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
      sectionElement(section.label, section.items ?? [], section.count),
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
      ),
    ),
  )
  const observed = Math.max(value.beads.observedAt ?? 0, value.crew.observedAt ?? 0)
  asOf.textContent = observed
    ? `As of ${new Date(observed).toLocaleTimeString()}`
    : 'No snapshot yet'
}

function sectionElement(label, items, count) {
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
    row.append(title, id)
    list.append(row)
  }
  container.append(list)
  return container
}
