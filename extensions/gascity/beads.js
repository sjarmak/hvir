/* global window, document */
const { availability } = window.host
const ui = Object.fromEntries(
  ['filter', 'refresh', 'status', 'connect', 'groups'].map((id) => [id, document.getElementById(id)]),
)
const STATUS_ORDER = ['in_progress', 'open', 'blocked', 'deferred']
/** Large rigs exceed the 4 MiB connector bound and page slowly at 8 KiB; show the top slice. */
const LIMIT = 150
let issues = []
let workspaceId
let lists = []

function grouped() {
  const needle = ui.filter.value.trim().toLowerCase()
  const matches = issues.filter(
    (issue) => !needle || `${issue.id} ${issue.title}`.toLowerCase().includes(needle),
  )
  const byStatus = Map.groupBy(matches, (issue) => issue.status)
  const extra = [...byStatus.keys()].filter((status) => !STATUS_ORDER.includes(status))
  return [...STATUS_ORDER, ...extra]
    .filter((status) => byStatus.has(status))
    .map((status) => [status, byStatus.get(status)])
}

function render() {
  for (const list of lists) list.dispose()
  lists = []
  ui.groups.replaceChildren(
    ...grouped().map(([status, members]) => {
      const list = window.el('div', { ariaLabel: status }, ...members.map(window.beadRow))
      list.setAttribute('role', 'listbox')
      lists.push(window.hvirUI.bindList(list, (row) => void open(row.dataset.id)))
      return window.el(
        'section',
        { className: 'group' },
        window.el('h2', { className: 'hvir-meta' }, `${status.replace('_', ' ')} · ${members.length}`),
        list,
      )
    }),
  )
}

async function open(id) {
  try {
    await window.openOwn('bead', { id })
  } catch (error) {
    ui.status.textContent = `Could not open ${id}: ${error.message}`
  }
}

async function load(context) {
  if (!context.workspace) {
    ui.status.textContent = 'No workspace selected'
    return
  }
  if (context.workspace.id !== workspaceId) {
    workspaceId = context.workspace.id
    issues = []
    render()
  }
  const connectors = await availability({ workspace: context.workspace })
  if (connectors.bd !== 'supported') {
    ui.status.textContent = window.hostNote('bd', connectors, context.workspace)
    ui.connect.hidden = connectors.bd === 'other-host'
    return
  }
  ui.connect.hidden = true
  issues = await window.bdRead(context.workspace, [
    'list', '--json', '--flat', '--no-pager',
    '--status', 'open,in_progress,blocked', '--sort', 'priority', '-n', String(LIMIT),
  ])
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  ui.status.textContent = `${issues.length}${issues.length === LIMIT ? '+' : ''} open · updated ${time}${window.bdNote(context.workspace)}`
  render()
}

const view = window.startView({ load, refreshMs: 60000, onStatus: (text) => (ui.status.textContent = text) })
ui.filter.addEventListener('input', render)
ui.refresh.addEventListener('click', () => void view.refresh())
ui.connect.addEventListener(
  'click',
  window.connectHandler('bd', (text) => (ui.status.textContent = text), view.refresh),
)
