/* global window, document */
const ui = Object.fromEntries(
  ['title', 'meta', 'status', 'connect', 'body', 'checks', 'failing', 'record', 'url'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const CONNECTOR = 'city-pr'
const model = window.pullModel
const setStatus = (text) => (ui.status.textContent = text)
let view

function render(shown, { pull, record, record_error: recordError }) {
  document.title = `${shown.repo}#${pull.number}`
  ui.title.textContent = pull.title ?? `${shown.repo}#${shown.number}`
  ui.meta.textContent = model.metaLine(pull, shown.repo)
  const summary = model.checks(pull.statusCheckRollup)
  ui.checks.textContent = model.checksLine(summary)
  ui.failing.replaceChildren(...summary.failing.map((name) => window.el('li', {}, name)))
  ui.record.textContent = recordError ? `Review record unavailable: ${recordError}` : model.recordLine(record, pull.headRefOid)
  ui.url.textContent = pull.url ?? ''
  ui.body.hidden = false
}

async function load(context) {
  const shown = model.target(context.input)
  if (!shown) {
    ui.title.textContent = 'No pull request selected'
    return
  }
  const { workspace } = context
  const connectors = await window.host.availability({ workspace })
  ui.connect.hidden = connectors[CONNECTOR] === 'supported'
  if (!ui.connect.hidden) {
    ui.title.textContent = `${shown.repo}#${shown.number}`
    setStatus(window.hostNote(CONNECTOR, workspace))
    return
  }
  const result = await window.host.run(CONNECTOR, workspace, model.prArgs(shown))
  setStatus('')
  render(shown, result)
}

view = window.startView({ load, onStatus: setStatus })
ui.connect.addEventListener('click', () => void window.connectHandler(CONNECTOR, setStatus, view.refresh)())
