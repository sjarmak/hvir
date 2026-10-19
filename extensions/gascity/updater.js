/* global window */
/** Publishes each visible session's workspace ready-bead count to the `ready` rail item. */
const bridge = window.hvirExtension
const { request } = window.host
const REFRESH_MS = 30000
/** bd ready caps at 100 by default; ask for that cap explicitly and label a full page as 100+. */
const READY_CAP = 100
let context = { visible: false, sessions: [] }
let pending = false
let lastRun = 0

async function readyCount(workspace) {
  try {
    const count = (await window.bdRead(workspace, ['ready', '--json', '-n', String(READY_CAP)])).length
    return { ok: true, count: count === READY_CAP ? `${READY_CAP}+` : String(count) }
  } catch (error) {
    return { ok: false, reason: error.reason, message: error.message }
  }
}

function publish(session, result) {
  const value = result.ok
    ? {
        label: `${result.count} ready`,
        tooltip: `${result.count} ready beads in ${session.workspace.name}`,
        availability: 'current',
        observedAt: Date.now(),
      }
    : {
        label: 'bd ?',
        tooltip: result.message.slice(0, 160),
        availability: result.reason === 'disconnected' ? 'disconnected' : 'failed',
      }
  return request('contributions.publish', { item: 'ready', session: session.id, ...value })
}

async function refresh() {
  if (pending || !context.visible || Date.now() - lastRun < REFRESH_MS) return
  pending = true
  lastRun = Date.now()
  try {
    const sessions = context.sessions ?? []
    const workspaces = new Map(sessions.map((session) => [session.workspace.id, session.workspace]))
    const counts = new Map()
    for (const [id, workspace] of workspaces) counts.set(id, await readyCount(workspace))
    if (!context.visible) return
    for (const session of sessions) await publish(session, counts.get(session.workspace.id))
  } catch {
    lastRun = 0
  } finally {
    pending = false
  }
}

bridge.onMessage((message) => {
  if (message.kind !== 'context') return
  if (message.context.visible && !context.visible) lastRun = 0
  context = message.context
  void refresh()
})
bridge.send({ kind: 'hello', contract: '1.0' })
window.setInterval(refresh, 1000)
