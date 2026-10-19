/* global window, document */
/**
 * Guest view lifecycle: presentation binding, hello, context tracking, refresh while visible,
 * and teardown on revoke/pagehide. `load(context)` runs on visibility, on context change and
 * every `refreshMs` while visible; it never overlaps itself.
 */
window.startView = ({ load, refreshMs = 0, onStatus = () => {} }) => {
  const bridge = window.hvirExtension
  const unbindPresentation = window.hvirUI.bindPresentation(bridge)
  let context
  let timer
  let running = false
  let disposed = false

  async function tick() {
    if (running || disposed || !context?.visible) return
    running = true
    try {
      await load(context)
    } catch (error) {
      if (error.reason !== 'frequency') onStatus(error.message)
    } finally {
      running = false
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
    if (message.kind === 'hello')
      window.host.request('context.read').then(apply, (error) => onStatus(error.message))
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
  node.append(...children.filter((child) => child !== undefined && child !== null && child !== false))
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
    { type: 'button', className: 'hvir-row option-row', title: hover ?? title, tabIndex: -1 },
    window.el('span', { className: 'option-title' }, title),
    window.el('span', { className: 'hvir-meta' }, ...[meta].flat()),
  )
  option.dataset.variant = 'selectable'
  option.setAttribute('role', 'option')
  Object.assign(option.dataset, data)
  return option
}

/** Open one of this package's own detail tabs. */
window.openOwn = (contributionId, input) =>
  window.host.request('viewer.open-own', { contributionId, input })

/** One event as a list item: type and subject, then actor/bead and age. */
window.eventItem = (event) => {
  const bead = event.payload?.bead
  const detail = [event.actor, bead?.title].filter(Boolean).join(' · ')
  const item = window.el(
    'li',
    { className: 'event', title: JSON.stringify(event.payload ?? {}).slice(0, 400) },
    window.el('span', {}, `${event.type}${event.subject ? ` · ${event.subject}` : ''}`),
    window.el('span', { className: 'hvir-meta' }, [detail, window.ago(event.ts)].filter(Boolean).join(' · ')),
  )
  if (event.ok === false) item.dataset.failed = 'true'
  return item
}

/** True when `path` is `rigPath` or inside it. */
window.inRig = (path, rigPath) => !!path && (path === rigPath || path.startsWith(`${rigPath}/`))

/** The rig (from `gc status --json` rigs) whose path is the longest prefix of `root`, if any. */
window.rigFor = (root, rigs) =>
  [...rigs].sort((a, b) => b.path.length - a.path.length).find((entry) => window.inRig(root, entry.path))

/**
 * Sessions record their rig as a template prefix (`gascity/...`), a template path under the rig
 * (pool workers, whose work_dir is a sibling worktree), or only through work_dir.
 */
window.sessionInRig = (session, scope) =>
  window.inRig(session.work_dir, scope.path) ||
  window.inRig(session.template, scope.path) ||
  (session.template ?? '').startsWith(`${scope.name}/`)

/** gc reports never-active sessions as "" on Linux and the zero time 0001-01-01 on macOS. */
window.knownTime = (iso) => Date.parse(iso) > 0

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

/**
 * Incremental city event feed: the first poll reads `--since <window>` and the head seq; later
 * polls replay only events after the last seen seq (`--watch` returns buffered events at once
 * and waits at most two seconds when there are none). Resolves new events oldest first.
 */
window.eventFeed = (window_ = '10m') => {
  let lastSeq
  let workspaceId
  return {
    async poll(workspace) {
      const { run } = window.host
      if (workspace.id !== workspaceId) {
        workspaceId = workspace.id
        lastSeq = undefined
      }
      let fresh
      if (lastSeq === undefined) {
        const head = Number(await run('gc', workspace, ['events', '--seq']))
        fresh = await run('gc', workspace, ['events', '--since', window_], { lines: true })
        lastSeq = head
      } else {
        fresh = await run(
          'gc',
          workspace,
          ['events', '--watch', '--after', String(lastSeq), '--timeout', '2s'],
          { lines: true },
        )
      }
      for (const event of fresh) lastSeq = Math.max(lastSeq, event.seq ?? 0)
      return fresh
    },
    get workspaceId() {
      return workspaceId
    },
  }
}

/** A selectable bead row: title over priority, id and type. */
window.beadRow = (issue) => {
  const priority = window.el('span', { className: 'bead-priority' }, `P${issue.priority}`)
  priority.dataset.priority = String(issue.priority)
  return window.optionRow({
    title: issue.title,
    hover: `${issue.id}: ${issue.title}`,
    meta: [priority, ` · ${issue.id} · ${issue.issue_type}`],
    data: { id: issue.id },
  })
}

/**
 * Workspace ids whose bead store refuses --readonly (dolt proxied-server mode, by bd's design).
 * Reads there run without the flag; list, ready and show do not write.
 */
const unguardedBeadStores = new Set()

/** Run a read-only bd command, dropping --readonly only where the store refuses it. */
window.bdRead = async (workspace, args) => {
  if (unguardedBeadStores.has(workspace.id)) return window.host.run('bd', workspace, args)
  try {
    return await window.host.run('bd', workspace, ['--readonly', ...args])
  } catch (error) {
    if (error.code !== 'proxy.readonly.unsupported') throw error
    unguardedBeadStores.add(workspace.id)
    return window.host.run('bd', workspace, args)
  }
}

/** Status-line suffix telling the viewer bd ran without --readonly for this workspace. */
window.bdNote = (workspace) =>
  unguardedBeadStores.has(workspace.id) ? ' · store refuses --readonly' : ''

/** Why a connector can't serve this workspace: never approved, or approved for another host. */
window.hostNote = (connector, connectors, workspace) =>
  connectors[connector] === 'other-host'
    ? `${connector} is approved for ${connectors.hosts[connector].join(', ')}, not ${workspace.host}. ${
        connectors.freeSlot[connector]
          ? `Approve ${connectors.freeSlot[connector]} for ${workspace.host}`
          : `All ${connector} host slots are in use; revoke one and approve it for ${workspace.host}`
      } in Settings → Extensions.`
    : `${connector} is not connected for this workspace host.`
