/* global window, document */
const ui = Object.fromEntries(
  ['title', 'meta', 'status', 'description', 'acceptance', 'acceptance-section', 'dependencies', 'dependencies-section'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** An optional absolute rig directory for beads outside the workspace's store (decisions asks). */
const RIG_PATH = /^\/[^\0\n]{0,1023}$/
let shownKey

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
  const { id, rig } = context.input ?? {}
  const key = `${rig ?? ''}#${id}`
  if (key === shownKey) return
  if (typeof id !== 'string' || !BEAD_ID.test(id) || (rig !== undefined && (typeof rig !== 'string' || !RIG_PATH.test(rig)))) {
    ui.title.textContent = 'No bead selected'
    return
  }
  const scope = rig === undefined ? [] : ['-C', rig]
  const [issue] = await window.bdRead(context.workspace, [...scope, 'show', id, '--json'])
  if (!issue) throw new Error(`${id} was not found in ${rig ?? "this workspace's beads"}`)
  shownKey = key
  ui.status.textContent = ''
  render(issue)
}

window.startView({ load, onStatus: (text) => (ui.status.textContent = text) })
