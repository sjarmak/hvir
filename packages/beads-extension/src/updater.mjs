import { guestClient } from '../../../src/shared/extensions/guest-client.mjs'
import { readWorkspace } from './bridge.mjs'
import { buildReadSurface } from './model.mjs'
import { createRefreshController } from './refresh.mjs'

const { window } = globalThis
const bridge = window.hvirExtension
const client = guestClient(bridge)
let context = { visible: false }
let snapshot

const controller = createRefreshController({
  async refresh() {
    return buildReadSurface(await readWorkspace(client, context, snapshot))
  },
  async publish(value) {
    const failures = [value.beads, value.crew].filter(
      (source) => source.state === 'error' || source.state === 'unavailable',
    )
    const count = value.beads.sections.reduce(
      (total, section) => total + section.count,
      0,
    )
    await client.request('contributions.publish', {
      item: 'status',
      label: failures.length ? 'Beads unavailable' : `Beads ${count}`,
      tooltip: failures.length
        ? failures.map((source) => source.message).join(' · ')
        : `${count} visible work items in the current as-of snapshot`,
      availability: failures.length ? 'failed' : 'current',
      ...(failures.length ? {} : { observedAt: Date.now() }),
    })
    snapshot = value
  },
  fail(error) {
    globalThis.queueMicrotask(() => {
      throw error
    })
  },
})

client.listen((message) => {
  if (message.kind !== 'context') return
  context = message.context
  controller.setVisible(context.visible)
})
window.addEventListener('pagehide', () => {
  controller.dispose()
  client.dispose()
})
client.hello()
