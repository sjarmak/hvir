/* global window, document */
const { run, availability } = window.host
const { ASK_RIG, MAX_ASKS, decisionsRig, askArgs, openAsks } = window.needsModel
const ui = Object.fromEntries(
  ['refresh', 'status', 'connect', 'asks'].map((id) => [id, document.getElementById(id)]),
)
let list
let missing

function askRow(issue, rig) {
  const priority = window.el('span', { className: 'bead-priority' }, `P${issue.priority}`)
  priority.dataset.priority = String(issue.priority)
  const owner = issue.metadata?.['gc.owner']
  const meta = [
    issue.id,
    owner && `from ${owner}`,
    issue.created_at && window.ago(issue.created_at),
  ]
  return window.optionRow({
    title: issue.title,
    hover: `${issue.id}: ${issue.title}`,
    meta: [priority, ` · ${meta.filter(Boolean).join(' · ')}`],
    data: { id: issue.id, rig: rig.path },
  })
}

function render(asks, rig) {
  list?.dispose()
  ui.asks.replaceChildren(...asks.map((issue) => askRow(issue, rig)))
  list = window.hvirUI.bindList(ui.asks, (row) =>
    window
      .openOwn('bead', { id: row.dataset.id, rig: row.dataset.rig })
      .catch(
        (error) =>
          (ui.status.textContent = `Could not open ${row.dataset.id}: ${error.message}`),
      ),
  )
}

/** The first of gc and bd that cannot run for this workspace's host, if any. */
async function unavailableConnector(workspace) {
  const connectors = await availability({ workspace })
  const connector = ['gc', 'bd'].find((name) => connectors[name] !== 'supported')
  return (
    connector && {
      connector,
      note: window.hostNote(connector, connectors, workspace),
      connectors,
    }
  )
}

async function load(context) {
  if (!context.workspace) {
    ui.status.textContent = 'No workspace selected'
    return
  }
  missing = await unavailableConnector(context.workspace)
  ui.connect.hidden = !missing || missing.connectors[missing.connector] === 'other-host'
  if (missing) {
    ui.connect.textContent = `Connect ${missing.connector}`
    ui.status.textContent = missing.note
    render([])
    return
  }
  const rig = decisionsRig(
    window.crewParse.parseRigList(
      await run('gc', context.workspace, ['rig', 'list', '--json']),
    ).rigs,
  )
  if (!rig) {
    render([])
    ui.status.textContent = `This city has no rig named ${ASK_RIG}, so there are no asks to show.`
    return
  }
  const { asks, total, truncated } = openAsks(
    await window.bdRead(context.workspace, askArgs(rig.path)),
  )
  render(asks, rig)
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const count = truncated
    ? `First ${MAX_ASKS} of ${total} asks`
    : `${total} ${total === 1 ? 'ask' : 'asks'}`
  ui.status.textContent = `${count} · ${rig.path} · updated ${time}${window.bdNote(context.workspace)}`
}

const view = window.startView({
  load,
  refreshMs: 60000,
  onStatus: (text) => (ui.status.textContent = text),
})
ui.refresh.addEventListener('click', () => void view.refresh())
ui.connect.addEventListener('click', () =>
  window.connectHandler(
    missing.connector,
    (text) => (ui.status.textContent = text),
    view.refresh,
  )(),
)
