/* global window, document */
const ui = Object.fromEntries(
  ['title', 'meta', 'status', 'page', 'original', 'acceptance', 'acceptance-section', 'dependencies', 'dependencies-section'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** An optional absolute rig directory for beads outside the workspace's store (decisions asks). */
const RIG_PATH = /^\/[^\0\n]{0,1023}$/
const TARGET_TOKEN = /^[\w.-]{0,128}$/
const validTarget = (target) => target === undefined || (typeof target === 'object' && target !== null &&
  typeof target.token === 'string' && TARGET_TOKEN.test(target.token) && typeof target.agent === 'boolean' &&
  typeof target.title === 'string' && target.title.length <= 1000)
let shownKey

function render(issue, card, target) {
  document.title = issue.id
  ui.title.textContent = issue.title
  ui.meta.textContent = [issue.id, issue.status, `P${issue.priority}`, issue.issue_type, issue.assignee]
    .filter(Boolean)
    .join(' · ')
  const page = window.beadPage.pageOf(issue, card, new Date().toISOString(), target)
  ui.page.replaceChildren(...window.beadPage.renderPage(page))
  ui.original.replaceChildren(...[window.beadPage.renderOriginal(page)].filter(Boolean))
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

async function cardFor(workspace, issue) {
  const needs = window.needsModel
  try {
    const [record] = await window.bdRead(workspace, ['show', needs.CARD_TEXTS_RECORD, '--json'])
    const cards = needs.cardTextRecord(record ? [record] : [])
    return { text: needs.cardText(issue, cards.texts), details: cards.details.get(issue.id) ?? '', invalid: cards.invalid || !record }
  } catch {
    return { text: needs.cardText(issue), details: '', invalid: true }
  }
}

async function load(context) {
  const { id, rig, target } = context.input ?? {}
  const key = `${rig ?? ''}#${id}#${JSON.stringify(target ?? null)}`
  if (key === shownKey) return
  if (typeof id !== 'string' || !BEAD_ID.test(id) || (rig !== undefined && (typeof rig !== 'string' || !RIG_PATH.test(rig))) || !validTarget(target)) {
    ui.title.textContent = 'No bead selected'
    return
  }
  const scope = rig === undefined ? [] : ['-C', rig]
  const [issue] = await window.bdRead(context.workspace, [...scope, 'show', id, '--json', '--include-comments'])
  if (!issue) throw new Error(`${id} was not found in ${rig ?? "this workspace's beads"}`)
  const card = await cardFor(context.workspace, issue)
  shownKey = key
  ui.status.textContent = ''
  render(issue, card, target)
}

window.startView({ load, onStatus: (text) => (ui.status.textContent = text) })
