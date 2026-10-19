/* global window, document */
const ui = Object.fromEntries(
  ['title', 'meta', 'status', 'description', 'acceptance', 'acceptance-section', 'dependencies', 'dependencies-section'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
let shownId

function render(issue) {
  document.title = issue.id
  ui.title.textContent = issue.title
  ui.meta.textContent = [issue.id, issue.status, `P${issue.priority}`, issue.issue_type, issue.assignee]
    .filter(Boolean)
    .join(' · ')
  ui.description.textContent = issue.description ?? ''
  ui.acceptance.textContent = issue.acceptance_criteria ?? ''
  ui['acceptance-section'].hidden = !issue.acceptance_criteria
  const deps = issue.dependencies ?? []
  ui.dependencies.replaceChildren(
    ...deps.map((dep) =>
      window.el(
        'li',
        {},
        [dep.id ?? dep.depends_on_id, dep.dependency_type ?? dep.type, dep.title].filter(Boolean).join(' · '),
      ),
    ),
  )
  ui['dependencies-section'].hidden = deps.length === 0
}

async function load(context) {
  const id = context.input?.id
  if (id === shownId) return
  if (typeof id !== 'string' || !BEAD_ID.test(id)) {
    ui.title.textContent = 'No bead selected'
    return
  }
  const [issue] = await window.bdRead(context.workspace, ['show', id, '--json'])
  if (!issue) throw new Error(`${id} was not found in this workspace's beads`)
  shownId = id
  ui.status.textContent = ''
  render(issue)
}

window.startView({ load, onStatus: (text) => (ui.status.textContent = text) })
