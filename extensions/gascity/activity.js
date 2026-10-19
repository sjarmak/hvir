/* global window, document */
const { run } = window.host
const ui = Object.fromEntries(['name', 'scope', 'filter', 'status', 'events'].map((id) => [id, document.getElementById(id)]))
const KEEP = 300
/** Raw city events kept so the rig view and the whole-city toggle both draw from the same history. */
const RAW_KEEP = 2000
/** Rig membership (rigs and sessions) changes slowly; re-read it at most once a minute. */
const SCOPE_REFRESH_MS = 60 * 1000
const feed = window.eventFeed('10m')
const textOf = new WeakMap()
let events = []
let lastFresh = []
/** Last rig-scope refresh failure; events keep flowing under the previous scope meanwhile. */
let scopeError = ''
let cityName = ''
/** Rig the workspace root sits in, or undefined at the city root and outside any rig. */
let rig
/** JSON fragments that tie an event to the rig; empty when there is no rig. */
let needles = []
let scopeLoadedAt = 0
let wholeCity = false

const quoted = (text) => JSON.stringify(text)
const unquoted = (text) => quoted(text).slice(1, -1)

/** Events carry no rig field: one is in the rig when its JSON holds the rig path, a `<rig>/` name, a `rig:<rig>` store ref, or the exact id, name or alias of a rig session. */
function rigNeedles(scope, sessions) {
  const path = unquoted(scope.path)
  const names = sessions.flatMap((session) => [session.id, session.session_name, session.alias]).filter(Boolean)
  return [`${path}/`, `${path}"`, `"${unquoted(scope.name)}/`, `rig:${unquoted(scope.name)}"`, ...new Set(names.map(quoted))]
}

function inScope(event) {
  if (wholeCity || !rig) return true
  if (!textOf.has(event)) textOf.set(event, JSON.stringify(event))
  const text = textOf.get(event)
  return needles.some((needle) => text.includes(needle))
}

/** City name and rigs from `gc rig list`; never `gc status`, whose runtime probe has taken over 120 s. */
async function loadScope(workspace) {
  const city = window.crewParse.parseRigList(await run('gc', workspace, ['rig', 'list', '--json']))
  cityName = city.cityName ?? ''
  rig = window.rigFor(workspace.root?.path, city.rigs.filter((entry) => !entry.hq))
  if (rig) {
    const sessions = window.crewParse.sessionRows(await run('gc', workspace, ['session', 'list', '--json']))
    needles = rigNeedles(rig, sessions.filter((session) => window.sessionInRig(session, rig)))
  } else needles = []
  scopeLoadedAt = Date.now()
}

function render() {
  const scoped = !wholeCity && rig
  ui.name.textContent = scoped ? `${rig.name} · ${cityName}` : cityName || 'City activity'
  ui.scope.hidden = !rig
  ui.scope.textContent = scoped ? 'Whole city' : `Rig ${rig?.name ?? ''}`
  const needle = ui.filter.value.trim().toLowerCase()
  const shown = events
    .filter(inScope)
    .filter((event) => !needle || `${event.type} ${event.subject ?? ''} ${event.actor ?? ''}`.toLowerCase().includes(needle))
    .slice(0, KEEP)
  ui.events.replaceChildren(...shown.map(window.eventItem))
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  const of = scoped ? ` of ${events.length} in city` : ''
  const warning = scopeError ? ` · scope not refreshed: ${scopeError}` : ''
  ui.status.textContent = `${shown.length} events${of} · +${lastFresh.filter(inScope).length} · ${time}${warning}`
}

async function load(context) {
  if (!context.workspace) {
    ui.status.textContent = 'No workspace selected'
    return
  }
  if (context.workspace.id !== feed.workspaceId) {
    events = []
    lastFresh = []
    scopeLoadedAt = 0
    wholeCity = false
  }
  if (Date.now() - scopeLoadedAt > SCOPE_REFRESH_MS) {
    try {
      await loadScope(context.workspace)
      scopeError = ''
    } catch (error) {
      if (error.reason === 'frequency') throw error
      scopeError = error.message
      scopeLoadedAt = Date.now()
    }
  }
  const fresh = await feed.poll(context.workspace)
  lastFresh = fresh
  events = [...[...fresh].reverse(), ...events].slice(0, RAW_KEEP)
  render()
}

window.startView({ load, refreshMs: 5000, onStatus: (text) => (ui.status.textContent = text) })
ui.filter.addEventListener('input', render)
ui.scope.addEventListener('click', () => {
  wholeCity = !wholeCity
  render()
})
