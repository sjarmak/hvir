/* global window, document */
const { run } = window.host
const ui = Object.fromEntries(
  ['title', 'meta', 'status', 'beads', 'events', 'peek', 'peek-status', 'peek-refresh'].map((id) => [
    id,
    document.getElementById(id),
  ]),
)
const { PEEK_LINES, peekArgs, peekTail } = window.peek
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_EVENTS = 100
/** Beads and session state change slowly; events stream incrementally every refresh. */
const SLOW_REFRESH_MS = 60000
const feed = window.eventFeed('10m')
let beadList
let mine = []
let slowLoadedAt = 0
let sessionId
/** Named sessions (mayor, *-pl) own beads and appear in events under their alias, not their id. */
let alias

function renderSession(session) {
  document.title = session.alias || session.session_name || session.id
  ui.title.textContent = document.title
  ui.meta.textContent = [session.id, session.state, session.reason, session.work_dir]
    .filter(Boolean)
    .join(' · ')
}

/** Latest known state of each bead assigned to this session, from its bead events. */
function assignedBeads(events) {
  const beads = new Map()
  // Events from several assignee queries arrive concatenated; seq order keeps the latest state.
  for (const event of [...events].sort((x, y) => x.seq - y.seq)) {
    const bead = event.payload?.bead
    if (bead?.id) beads.set(bead.id, bead)
  }
  return [...beads.values()].sort((a, b) => (a.status === 'closed') - (b.status === 'closed'))
}

function renderBeads(beads) {
  beadList?.dispose()
  ui.beads.replaceChildren(
    ...beads.map((bead) =>
      window.optionRow({
        title: bead.title,
        hover: `${bead.id}: ${bead.title}`,
        meta: `${bead.status} · ${bead.id} · ${bead.issue_type ?? ''}`,
        data: { id: bead.id },
      }),
    ),
  )
  beadList = window.hvirUI.bindList(ui.beads, (row) =>
    window.openOwn('bead', { id: row.dataset.id }).catch((error) => (ui.status.textContent = error.message)),
  )
}

/** The agent's pane, read-only (`gc session peek` never attaches or sends input), last PEEK_LINES lines. */
async function loadPeek(workspace, id) {
  try {
    const { text, shown, total } = peekTail(await run('gc', workspace, peekArgs(id), { text: true }))
    ui.peek.textContent = text
    ui.peek.hidden = shown === 0
    ui['peek-status'].textContent =
      shown === 0
        ? 'No output captured; the session may be asleep.'
        : `Last ${shown} of ${total} captured lines (capped at ${PEEK_LINES}) · read-only`
  } catch (error) {
    ui.peek.hidden = true
    ui['peek-status'].textContent = `Output unavailable: ${error.message}`
  }
}

async function load(context) {
  if (!context.workspace) {
    ui.title.textContent = 'No workspace selected'
    return
  }
  const id = context.input?.id
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    ui.title.textContent = 'No session selected'
    return
  }
  if (id !== sessionId || context.workspace.id !== feed.workspaceId) {
    sessionId = id
    alias = undefined
    mine = []
    slowLoadedAt = 0
  }
  if (Date.now() - slowLoadedAt > SLOW_REFRESH_MS) {
    const sessions = window.crewParse.sessionRows(await run('gc', context.workspace, ['session', 'list', '--json']))
    const session = sessions.find((entry) => entry.id === id)
    if (session) renderSession(session)
    else ui.meta.textContent = `${id} is no longer listed`
    alias = session?.alias || undefined
    const beadEvents = []
    for (const assignee of [id, alias].filter(Boolean))
      beadEvents.push(
        ...(await run(
          'gc',
          context.workspace,
          ['events', '--since', '24h', '--payload-match', `bead.assignee=${assignee}`],
          { lines: true },
        )),
      )
    renderBeads(assignedBeads(beadEvents))
    slowLoadedAt = Date.now()
  }
  await loadPeek(context.workspace, id)
  const fresh = await feed.poll(context.workspace)
  const related = fresh.filter((event) => {
    const text = JSON.stringify(event)
    return text.includes(id) || (!!alias && text.includes(`"${alias}"`))
  })
  mine = [...related.reverse(), ...mine].slice(0, MAX_EVENTS)
  ui.events.replaceChildren(...mine.map(window.eventItem))
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  ui.status.textContent = `${mine.length} recent events · updated ${time}`
}

/** Each refresh runs `gc session peek` and an events poll on the city host; Refresh reads now. */
const REFRESH_MS = 30000
const view = window.startView({ load, refreshMs: REFRESH_MS, onStatus: (text) => (ui.status.textContent = text) })
ui['peek-refresh'].addEventListener('click', () => void view.refresh())
