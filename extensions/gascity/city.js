/* global window, document */
const { run, availability, request } = window.host
const { el, rigFor } = window
const { parseSessions, parseRigList, parseConfig, hasProjectedTierFields } = window.crewParse
const { deriveCrew, crewView, activityBand } = window.crew
const ui = Object.fromEntries(
  ['name', 'scope', 'activity', 'status', 'connect', 'crew', 'internals', 'ready', 'orders', 'formulas', 'rigs'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const heading = (id, text) => (document.getElementById(`${id}-heading`).textContent = text)
/** Orders, formulas and the resolved city config change slower than sessions; refresh them less often. */
const CONFIG_REFRESH_MS = 5 * 60 * 1000
const READY_REFRESH_MS = 60 * 1000
/** Rigs and the city's identity change when config is edited; `gc rig list` costs seconds, so hold it a minute. */
const RIGS_REFRESH_MS = 60 * 1000
const READY_LIMIT = 20
/** In-progress beads read for the crew's bead join when gc projects no `active_bead`. */
const IN_FLIGHT_LIMIT = 200
const EMPTY_CONFIG = Object.freeze({ agents: [], namedSessions: [] })
let configLoadedAt = 0
let readyLoadedAt = 0
let workspaceId
/** Last `gc rig list`, parsed, and when it was read. */
let city
let cityLoadedAt = 0
/** Rig the workspace root sits in, or undefined at the city root and outside any rig. */
let rig
/** The viewer chose the whole city while standing in a rig. */
let wholeCity = false
let orders = []
/** Resolved city config for tiering, re-read on the config cadence; a failed read leaves the previous one. */
let cityConfig = EMPTY_CONFIG
let cityConfigLoadedAt = 0
let cityConfigError = ''
/** In-progress beads in this workspace's store, and why they could not be read. */
let inFlight = []
let inFlightNote = ''
/** Last derived crew, re-rendered when the bead join changes. */
let crew
/** One list binding per container; ready rows refresh on their own cadence. */
const lists = new Map()

function bindRows(container, rows, onSelect) {
  lists.get(container)?.dispose()
  container.replaceChildren(...rows)
  lists.set(container, window.hvirUI.bindList(container, onSelect))
}

const reportOpenError = (error) => (ui.status.textContent = error.message)
const openSession = (row) => window.openOwn('session', { id: row.dataset.id }).catch(reportOpenError)

/** One crew card: state, context use and the bead being worked; a dormant lead is listed but inert. */
function crewRow({ member, bead }) {
  const { session } = member
  const row = window.optionRow({
    title: member.label,
    hover: session ? `${session.id} · ${session.workDir ?? ''}` : `${member.target}: configured, not running`,
    meta: [
      el('span', { className: `state state-${session?.state ?? 'dormant'}` }, session?.state ?? 'not running'),
      member.cityLead ? ' · city' : '',
      session?.contextPct === undefined ? '' : ` · context ${Math.round(session.contextPct)}%`,
      bead ? ` · ${bead.id}${bead.title === bead.id ? '' : ` ${bead.title}`}` : '',
      window.knownTime(session?.lastActive) ? ` · active ${window.ago(session.lastActive)}` : '',
    ],
    data: session ? { id: session.id } : {},
  })
  row.dataset.band = activityBand(session?.state)
  if (!session) row.setAttribute('aria-disabled', 'true')
  return row
}

const groupLabel = (text) => el('div', { className: 'crew-group' }, text)

function renderCrew() {
  const view = crewView(crew.members, inFlight)
  const workers = view.pools.flatMap((pool) => [groupLabel(`${pool.label} · ${pool.cards.length}`), ...pool.cards.map(crewRow)])
  const leads = view.leads.length ? [groupLabel(`Leads · ${view.leads.length}`), ...view.leads.map(crewRow)] : []
  bindRows(ui.crew, [...leads, ...workers], openSession)
  bindRows(ui.internals, view.internals.map(crewRow), openSession)
  const live = crew.members.filter((member) => member.session)
  const active = live.filter((member) => activityBand(member.session.state) === 'active').length
  heading('crew', `${crew.scope === 'rig' ? 'Rig crew' : 'Crew'} · ${active} active of ${live.length}${inFlightNote}`)
  heading('internals', `Internal · ${view.internals.length}`)
  return active
}

function renderReady(issues) {
  bindRows(ui.ready, issues.map(window.beadRow), (row) => window.openOwn('bead', { id: row.dataset.id }).catch(reportOpenError))
  heading('ready', issues.length === READY_LIMIT ? `Ready · top ${READY_LIMIT}` : `Ready · ${issues.length}`)
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
        el('span', { className: 'hvir-meta' }, entry.hq ? 'city' : entry.suspended ? 'suspended' : 'live'),
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

function publishSummary(cityName, active, scope) {
  const total = crew.members.filter((member) => member.session).length
  return request('contributions.publish', {
    item: 'city',
    label: `${active} active`,
    tooltip: `${scope ? `${scope.name} in ` : ''}${cityName}: ${active} of ${total} sessions active`,
    availability: 'current',
    observedAt: Date.now(),
  }).catch((error) => {
    ui.status.textContent = `${ui.status.textContent} · header not updated: ${error.message}`
  })
}

/**
 * The resolved city config tiers the crew when gc does not project the tier fields itself. It is
 * large (hundreds of KB, many output pages), so it is read on the config cadence, not every tick.
 */
async function loadCityConfig(workspace, force) {
  if (!force && Date.now() - cityConfigLoadedAt < CONFIG_REFRESH_MS) return
  try {
    cityConfig = parseConfig(await run('gc', workspace, ['config', 'show', '--json']))
    cityConfigLoadedAt = Date.now()
    cityConfigError = ''
  } catch (error) {
    if (error.reason === 'frequency') throw error
    cityConfigError = /unknown flag: --json/.test(error.message)
      ? 'this gc has no `config show --json` (needs a newer gc build); tiers come from session fields only'
      : error.message
  }
}

async function loadBeads(workspace, scope) {
  const connectors = await availability({ workspace })
  if (connectors.bd !== 'supported') {
    const note = window.hostNote('bd', connectors, workspace)
    heading('ready', `Ready · ${note}`)
    inFlight = []
    inFlightNote = ` · beads: ${note}`
    return
  }
  try {
    inFlight = await window.bdRead(workspace, ['list', '--json', '--flat', '--no-pager', '--status', 'in_progress', '-n', String(IN_FLIGHT_LIMIT)])
    inFlightNote = ''
  } catch (error) {
    inFlight = []
    inFlightNote = ` · beads: ${error.message}`
  }
  if (!scope) return
  try {
    renderReady(await window.bdRead(workspace, ['ready', '--json', '-n', String(READY_LIMIT)]))
  } catch (error) {
    heading('ready', `Ready · ${error.message}`)
  }
}

async function loadSlow(workspace, scope, force) {
  if (force || Date.now() - configLoadedAt > CONFIG_REFRESH_MS) {
    orders = (await run('gc', workspace, ['order', 'list', '--json'])).orders ?? []
    renderFormulas((await run('gc', workspace, ['formula', 'list', '--json'])).formulas ?? [])
    configLoadedAt = Date.now()
  }
  renderOrders(scope)
  if (!force && Date.now() - readyLoadedAt < READY_REFRESH_MS) return false
  await loadBeads(workspace, scope)
  readyLoadedAt = Date.now()
  return true
}

async function loadCity(workspace, force) {
  if (!force && Date.now() - cityLoadedAt < RIGS_REFRESH_MS) return
  city = parseRigList(await run('gc', workspace, ['rig', 'list', '--json']))
  cityLoadedAt = Date.now()
}

function deriveFor(workspace, sessions, scope) {
  const tierSource = hasProjectedTierFields(sessions) ? 'session-fields' : 'config'
  return deriveCrew({
    sessions,
    config: tierSource === 'config' ? cityConfig : EMPTY_CONFIG,
    rigRoot: scope?.path ?? city.cityRoot ?? workspace.root?.path,
    rigName: scope?.name ?? city.hqRigName,
    cityRoot: city.cityRoot,
    hqRigName: city.hqRigName,
    cityWorkspace: !scope,
    includeInternals: true,
    tierSource,
  })
}

/** What the tiering could not account for, stated rather than left to look like an empty city. */
function crewNote(sessions) {
  const config = crew.tierSource === 'config'
  const parts = [
    config && cityConfigError ? `config not read: ${cityConfigError}` : '',
    config && crew.diagnostics.pinned === 0 ? 'no pinned leads in config' : '',
    crew.diagnostics.unmatched.length ? `not in config: ${crew.diagnostics.unmatched.join(', ')}` : '',
  ]
  const running = sessions.filter((session) => activityBand(session.state) === 'active').length
  return [`${running} sessions running in city`, ...parts].filter(Boolean).join(' · ')
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
    inFlight = []
    inFlightNote = ''
    // Caches belong to the previous workspace; a failed first load must not leave them looking fresh.
    city = undefined
    cityLoadedAt = 0
    cityConfig = EMPTY_CONFIG
    cityConfigLoadedAt = 0
    cityConfigError = ''
    configLoadedAt = 0
    readyLoadedAt = 0
    orders = []
    bindRows(ui.ready, [], () => {})
  }
  const connectors = await availability({ workspace: context.workspace })
  if (connectors.gc !== 'supported') {
    ui.status.textContent = window.hostNote('gc', connectors, context.workspace)
    ui.connect.hidden = connectors.gc === 'other-host'
    return
  }
  ui.connect.hidden = true
  const [sessions] = await Promise.all([
    run('gc', context.workspace, ['session', 'list', '--json']).then(parseSessions),
    loadCity(context.workspace, changed),
  ])
  const previous = rig?.path
  rig = rigFor(context.workspace.root?.path, city.rigs.filter((entry) => !entry.hq))
  const scope = wholeCity ? undefined : rig
  const force = changed || previous !== rig?.path
  if (!hasProjectedTierFields(sessions)) await loadCityConfig(context.workspace, changed)
  crew = deriveFor(context.workspace, sessions, scope)
  const cityName = city.cityName ?? ''
  ui.name.textContent = scope ? `${scope.name} · ${cityName}` : cityName
  showScope(scope)
  let active = renderCrew()
  renderRigs(city.rigs)
  if (await loadSlow(context.workspace, scope, force)) active = renderCrew()
  const rigState = scope ? `rig ${scope.suspended ? 'suspended' : 'live'} · ` : ''
  ui.status.textContent = `${rigState}${crewNote(sessions)}${window.bdNote(context.workspace)}`
  await publishSummary(cityName, active, scope)
}

/** Each tick runs `gc session list` on the city host; twice a minute keeps it light on the machine. */
const view = window.startView({ load, refreshMs: 30000, onStatus: (text) => (ui.status.textContent = text) })
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
