/* global window */
/**
 * Sole publisher of the header count: pull requests that need the viewer across the workspaces of
 * demanded sessions, deduplicated by URL (pullsModel.needYouCount). The pulls view only renders,
 * so the header keeps one meaning whether or not the view is open.
 */
const bridge = window.hvirExtension
const { request, availability } = window.host
const { needYouCount } = window.pullsModel
/** One gh snapshot per demanded workspace per cycle; the header count tolerates being minutes old. */
const REFRESH_MS = 5 * 60 * 1000
const TICK_MS = 1000
let context = { visible: false, sessions: [] }
let pending = false
/** When the last real refresh started; a skipped cycle leaves it alone. */
let lastRun = 0
let disposed = false

async function snapshotsAcross(workspaces) {
  const snapshots = []
  const failures = []
  for (const workspace of workspaces) {
    try {
      snapshots.push(await window.pullsSource.snapshot(workspace, 30, false))
    } catch (error) {
      failures.push(`${workspace.name}: ${error.message}`)
    }
  }
  return { snapshots, failures }
}

const publishFailure = (message) =>
  request('contributions.publish', {
    item: 'pulls',
    label: 'gh ?',
    tooltip: message.slice(0, 160),
    availability: 'failed',
  })

function publish({ snapshots, failures }) {
  if (snapshots.length === 0) return publishFailure(failures[0])
  const count = needYouCount(snapshots, Date.now())
  const missed = failures.length ? `; ${failures.length} unreadable` : ''
  return request('contributions.publish', {
    item: 'pulls',
    label: `${count} need you`,
    tooltip: `${count} pull requests need you across ${snapshots.length} workspaces${missed}`.slice(0, 160),
    availability: 'current',
    observedAt: Date.now(),
  })
}

const sessionWorkspaces = () => [
  ...new Map((context.sessions ?? []).map((session) => [session.workspace.id, session.workspace])).values(),
]

async function refresh() {
  if (disposed || pending || !context.visible || Date.now() - lastRun < REFRESH_MS) return
  const workspaces = sessionWorkspaces()
  if (workspaces.length === 0) return
  pending = true
  try {
    // gh runs only for workspaces whose host has it approved; the rest would answer `unavailable`.
    const approved = []
    for (const workspace of workspaces)
      if ((await availability({ workspace })).gh === 'supported') approved.push(workspace)
    if (approved.length === 0) return
    lastRun = Date.now()
    const result = await snapshotsAcross(approved)
    if (context.visible && !disposed) await publish(result)
  } catch (error) {
    await publishFailure(error.message).catch(() => {})
  } finally {
    pending = false
  }
}

const timer = window.setInterval(refresh, TICK_MS)

function dispose() {
  if (disposed) return
  disposed = true
  window.clearInterval(timer)
  unsubscribe()
  window.removeEventListener('pagehide', dispose)
}

const unsubscribe = bridge.onMessage((message) => {
  if (disposed) return
  if (message.kind === 'revoked') return dispose()
  if (message.kind !== 'context') return
  if (message.context.visible && !context.visible) lastRun = 0
  context = message.context
  void refresh()
})
window.addEventListener('pagehide', dispose)
bridge.send({ kind: 'hello', contract: '1.0' })
