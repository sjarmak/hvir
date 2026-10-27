/* global window, document */
/**
 * Guest view lifecycle: presentation binding, hello, context tracking, refresh while visible,
 * and teardown on revoke/pagehide. `load(context, current)` runs on visibility, on context change
 * and every `refreshMs` while visible; it never overlaps itself, and a request that arrives while
 * it runs queues one follow-up run. `current()` returns the latest context so a load can drop
 * results that belong to a context that has since moved on.
 */
window.startView = ({ load, refreshMs = 0, onStatus = () => {} }) => {
  const bridge = window.hvirExtension
  const unbindPresentation = window.hvirUI.bindPresentation(bridge)
  let context
  let timer
  let running = false
  let queued = false
  let disposed = false
  const current = () => context

  async function tick() {
    if (disposed || !context?.visible) return
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      await load(context, current)
    } catch (error) {
      if (!error.transient) onStatus(error.message)
    } finally {
      running = false
    }
    if (queued) {
      queued = false
      void tick()
    }
  }

  function apply(next) {
    context = next
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
    if (!context.visible || disposed) return
    void tick()
    if (refreshMs > 0) timer = window.setInterval(tick, refreshMs)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (timer !== undefined) window.clearInterval(timer)
    unsubscribe()
    unbindPresentation()
    window.removeEventListener('pagehide', dispose)
  }

  const unsubscribe = bridge.onMessage((message) => {
    if (disposed) return
    if (message.kind === 'hello') {
      window.grantedCapabilities = new Set(message.capabilities ?? [])
      window.host.request('context.read').then(apply, (error) => onStatus(error.message))
    }
    else if (message.kind === 'context') apply(message.context)
    else if (message.kind === 'revoked') dispose()
  })
  window.addEventListener('pagehide', dispose)
  bridge.send({ kind: 'hello', contract: '1.0' })
  return { refresh: tick }
}

/** Small DOM helper: el('span', { className: 'x' }, 'text', child). */
window.el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(
    ...children.filter(
      (child) => child !== undefined && child !== null && child !== false,
    ),
  )
  return node
}

/** "3m ago" style relative time for an ISO timestamp. */
window.ago = (iso) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${Math.round(seconds)}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

/** A selectable list row: wrapped title over one muted metadata line. */
window.optionRow = ({ title, meta, hover, data = {} }) => {
  const option = window.el(
    'button',
    {
      type: 'button',
      className: 'hvir-row option-row',
      title: hover ?? title,
      tabIndex: -1,
    },
    window.el('span', { className: 'option-title' }, title),
    window.el('span', { className: 'hvir-meta' }, ...[meta].flat()),
  )
  option.dataset.variant = 'selectable'
  option.setAttribute('role', 'option')
  Object.assign(option.dataset, data)
  return option
}

window.grantedCapabilities = new Set()

const openOnGitHub = (url, onStatus) =>
  window.host.request('viewer.open-external', { url }).catch((error) => onStatus(error.message))

window.githubLink = (url, onStatus) => {
  if (!window.grantedCapabilities.has('viewer.open-external')) return null
  const control = window.el('span', { className: 'chip chip-link', title: `Open ${url} in your browser` }, '↗ GitHub')
  control.setAttribute('role', 'button')
  control.tabIndex = 0
  const activate = (event) => {
    event.stopPropagation()
    event.preventDefault()
    void openOnGitHub(url, onStatus)
  }
  control.addEventListener('click', activate)
  control.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event)
    else event.stopPropagation()
  })
  return control
}

/** Open one of this package's own detail tabs. */
window.openOwn = (contributionId, input) =>
  window.host.request('viewer.open-own', { contributionId, input })

/** Shared connect-button handler for a connector that is not yet approved. */
window.connectHandler = (connector, onStatus, refresh) => async () => {
  try {
    const { connections } = await window.host.request('connector.connect', { connector })
    const outcome = connections.find((entry) => entry.connector === connector)
    onStatus(
      outcome
        ? `${outcome.outcome}${outcome.explanation ? `: ${outcome.explanation}` : ''}`
        : `Configure ${connector} for this host in Settings → Extensions (required for SSH workspaces).`,
    )
    void refresh()
  } catch (error) {
    onStatus(error.message)
  }
}

/** Why a connector can't serve this workspace. */
window.hostNote = (connector, workspace) =>
  workspace.host === 'local'
    ? `${connector} is not connected for this computer.`
    : `${connector} is not approved for host ${workspace.host}. Restart hvir through the launcher, or approve it under Settings → Extensions.`

/** An owner/name GitHub repository, as gh prints and accepts it. */
window.REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

/** hvir's terminal.start outcome; a declined confirmation is `not-started`, not an error. */
window.terminalOutcome = function terminalOutcome(result, started) {
  if (result?.outcome === 'handed-off') return started
  if (result?.outcome === 'not-started') return `Terminal not started: ${result.reason}`
  if (result?.outcome === 'interrupted-uncertain')
    return `The terminal may have started (${result.reason}). Check it before trying again.`
  return `Unexpected terminal result: ${JSON.stringify(result).slice(0, 120)}`
}
