/* global window, document */
const { run, availability, request } = window.host
const { el, rigFor, sessionInRig } = window
const ui = Object.fromEntries(
  ['name', 'scope', 'activity', 'status', 'connect', 'sessions', 'ready', 'agents', 'orders', 'formulas', 'rigs'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const heading = (id, text) => (document.getElementById(`${id}-heading`).textContent = text)
/** Orders, formulas and ready work change slower than sessions; refresh them less often. */
const CONFIG_REFRESH_MS = 5 * 60 * 1000
const READY_REFRESH_MS = 60 * 1000
const READY_LIMIT = 20
let configLoadedAt = 0
let readyLoadedAt = 0
let workspaceId
/** Rig the workspace root sits in, or undefined at the city root and outside any rig. */
let rig
/** The viewer chose the whole city while standing in a rig. */
let wholeCity = false
let orders = []
/** One list binding per container; ready rows refresh on their own cadence. */
const lists = new Map()

function bindRows(container, rows, onSelect) {
  lists.get(container)?.dispose()
  container.replaceChildren(...rows)
  lists.set(container, window.hvirUI.bindList(container, onSelect))
}

const reportOpenError = (error) => (ui.status.textContent = error.message)

function renderSessions(sessions, scope) {
  const rows = [...sessions]
    .sort((a, b) => Date.parse(b.last_active || 0) - Date.parse(a.last_active || 0))
    .map((session) =>
      window.optionRow({
        title: session.alias || session.session_name || session.id,
        hover: `${session.id} · ${session.work_dir}`,
        meta: [
          el('span', { className: `state state-${session.state}` }, session.state),
          ` · ${session.id}`,
          window.knownTime(session.last_active) ? ` · active ${window.ago(session.last_active)}` : '',
        ],
        data: { id: session.id },
      }),
    )
  bindRows(ui.sessions, rows, (row) => window.openOwn('session', { id: row.dataset.id }).catch(reportOpenError))
  const active = sessions.filter((session) => session.state === 'active').length
  heading('sessions', `${scope ? 'Rig sessions' : 'Sessions'} · ${active} active of ${sessions.length}`)
}

function renderReady(issues) {
  bindRows(ui.ready, issues.map(window.beadRow), (row) => window.openOwn('bead', { id: row.dataset.id }).catch(reportOpenError))
  heading('ready', issues.length === READY_LIMIT ? `Ready · top ${READY_LIMIT}` : `Ready · ${issues.length}`)
}

function renderAgents(agents) {
  ui.agents.replaceChildren(
    ...agents.map((agent) =>
      el(
        'div',
        { className: 'line', title: agent.qualified_name },
        el('span', {}, agent.name),
        el('span', { className: 'hvir-meta' }, agent.suspended ? 'suspended' : agent.running ? 'running' : 'idle'),
      ),
    ),
  )
  heading('agents', `Agents · ${agents.filter((agent) => agent.running).length} running of ${agents.length}`)
}

function renderOrders(scope) {
  const shown = scope ? orders.filter((order) => order.rig === scope.name) : orders
  ui.orders.replaceChildren(
    ...shown.map((order) =>
      el(
        'div',
        { className: 'line', title: order.description ?? '' },
        el('span', {}, order.scoped_name ?? order.name),
        el(
          'span',
          { className: 'hvir-meta' },
          [order.type, order.trigger, order.interval || order.schedule, order.enabled ? null : 'disabled']
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    ),
  )
  heading('orders', `${scope ? 'Rig orders' : 'Orders'} · ${shown.length}`)
}

function renderFormulas(formulas) {
  ui.formulas.replaceChildren(
    ...formulas.map((formula) => el('div', { className: 'line', title: formula.source ?? '' }, formula.name)),
  )
  heading('formulas', `Formulas · ${formulas.length}`)
}

function renderRigs(rigs) {
  ui.rigs.replaceChildren(
    ...rigs.map((entry) =>
      el(
        'div',
        { className: 'line', title: entry.path },
        el('span', {}, entry.name),
        el('span', { className: 'hvir-meta' }, entry.suspended ? 'suspended' : 'live'),
      ),
    ),
  )
  heading('rigs', `Rigs · ${rigs.length}`)
}

function showScope(scope) {
  for (const node of document.querySelectorAll('[data-rig-only]')) node.hidden = !scope
  for (const node of document.querySelectorAll('[data-city-only]')) node.hidden = !!scope
  ui.scope.hidden = !rig
  ui.scope.textContent = scope ? 'Whole city' : `Rig ${rig?.name ?? ''}`
}

function publishSummary(status, active, scope) {
  const healthy = status.running && status.health?.usable && !status.health?.degraded
  return request('contributions.publish', {
    item: 'city',
    label: `${active} active`,
    tooltip: `${scope ? `${scope.name} in ` : ''}${status.city_name}: ${healthy ? 'healthy' : 'degraded or stopped'}`,
    availability: 'current',
    observedAt: Date.now(),
  }).catch(() => {})
}

async function loadSlow(workspace, scope, force) {
  if (force || Date.now() - configLoadedAt > CONFIG_REFRESH_MS) {
    orders = (await run('gc', workspace, ['order', 'list', '--json'])).orders ?? []
    renderFormulas((await run('gc', workspace, ['formula', 'list', '--json'])).formulas ?? [])
    configLoadedAt = Date.now()
  }
  renderOrders(scope)
  if (!scope || (!force && Date.now() - readyLoadedAt < READY_REFRESH_MS)) return
  if ((await availability()).bd !== 'supported') {
    heading('ready', 'Ready · bd is not connected for this host')
    return
  }
  try {
    renderReady(await window.bdRead(workspace, ['ready', '--json', '-n', String(READY_LIMIT)]))
  } catch (error) {
    heading('ready', `Ready · ${error.message}`)
  }
  readyLoadedAt = Date.now()
}

async function load(context) {
  if (!context.workspace) {
    ui.status.textContent = 'No workspace selected'
    return
  }
  const changed = context.workspace.id !== workspaceId
  if (changed) {
    workspaceId = context.workspace.id
    wholeCity = false
  }
  if ((await availability()).gc !== 'supported') {
    ui.status.textContent = 'gc is not connected for this workspace host.'
    ui.connect.hidden = false
    return
  }
  ui.connect.hidden = true
  const status = await run('gc', context.workspace, ['status', '--json'])
  const all = (await run('gc', context.workspace, ['session', 'list', '--json'])).sessions
  const previous = rig?.path
  rig = rigFor(context.workspace.root?.path, status.rigs ?? [])
  const scope = wholeCity ? undefined : rig
  const sessions = scope ? all.filter((session) => sessionInRig(session, scope)) : all
  ui.name.textContent = scope ? `${scope.name} · ${status.city_name}` : status.city_name
  showScope(scope)
  renderSessions(sessions, scope)
  renderRigs(status.rigs ?? [])
  if (scope)
    renderAgents((status.agents ?? []).filter((agent) => agent.qualified_name?.startsWith(`${scope.name}/`)))
  await loadSlow(context.workspace, scope, changed || previous !== rig?.path)
  const active = sessions.filter((session) => session.state === 'active').length
  const health = status.health?.degraded ? 'degraded' : status.running ? 'running' : 'stopped'
  const rigState = scope ? ` · rig ${scope.suspended ? 'suspended' : 'live'}` : ''
  const warning = status.summary?.store_health?.warning ? ' · store size warning' : ''
  ui.status.textContent = `${health}${rigState} · ${status.summary?.running_agents ?? '?'} agents running in city${warning}${window.bdNote(context.workspace)}`
  await publishSummary(status, active, scope)
}

const view = window.startView({ load, refreshMs: 15000, onStatus: (text) => (ui.status.textContent = text) })
ui.scope.addEventListener('click', () => {
  wholeCity = !wholeCity
  readyLoadedAt = 0
  void view.refresh()
})
ui.activity.addEventListener('click', () => window.openOwn('activity', {}).catch(reportOpenError))
ui.connect.addEventListener(
  'click',
  window.connectHandler('gc', (text) => (ui.status.textContent = text), view.refresh),
)
