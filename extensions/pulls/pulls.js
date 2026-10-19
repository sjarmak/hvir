/* global window, document */
const { availability } = window.host
const { el } = window
const { pullSections, age, badges } = window.pullsModel
const { pullHandle } = window.pullWaits
const ui = Object.fromEntries(
  ['repo', 'refresh', 'status', 'connect-gh', 'connect-git', 'sections', 'more'].map((id) => [id, document.getElementById(id)]),
)
/** The panel polls every 60 s while visible (VISIBLE_POLL_INTERVAL_MS) and pages by 30 up to 60 (PULLS_MAX_LIMIT; 100 times out on GitHub). */
const REFRESH_MS = 60 * 1000
const PAGE_SIZE = 30
const MAX_LIMIT = 60
let limit = PAGE_SIZE
let workspaceId
/** Why This branch is empty when git can't run here; set per load. */
let gitNote = ''
/** Collapsed section keys survive re-renders, like the panel's collapsible headers. */
const collapsed = new Set()
let lists = []
const setStatus = (text) => (ui.status.textContent = text)

function pullRow(row, snapshot, now) {
  const { pull, reason, since, waitingOn } = row
  const chips = [
    reason ? el('span', { className: 'chip chip-reason' }, reason) : null,
    since === undefined ? null : ageChip(since, now),
    ...badges(row).map((label) => el('span', { className: 'chip' }, label)),
    pull.author && pull.author !== snapshot.viewer ? el('span', {}, `@${pull.author}`) : null,
    waitingOn.length ? el('span', {}, `waiting on ${waitingOn.map(pullHandle).join(', ')}`) : null,
  ].filter(Boolean)
  return window.optionRow({
    title: `#${pull.number} ${pull.title}`,
    hover: `${pull.headRef} · ${pull.url}`,
    meta: chips,
    data: { number: String(pull.number) },
  })
}

function ageChip(since, now) {
  const { label, tone } = age(since, now)
  const chip = el('span', { className: 'chip chip-age', title: new Date(since).toLocaleString() }, label)
  chip.dataset.tone = tone
  return chip
}

function branchNote(snapshot) {
  if (!snapshot.gitChecked) return gitNote
  return snapshot.branch === undefined
    ? 'Detached HEAD, so no branch pull request.'
    : `No pull request for ${snapshot.branch}.`
}

function renderSection(section, snapshot, now) {
  const list = el('div', { role: 'listbox' })
  list.setAttribute('aria-label', section.label)
  list.dataset.section = section.key
  const summary = el('summary', {}, `${section.label} · ${section.rows.length}`)
  const details = el('details', { open: !collapsed.has(section.key) }, summary, list)
  details.addEventListener('toggle', () => (details.open ? collapsed.delete(section.key) : collapsed.add(section.key)))
  if (section.rows.length === 0) list.append(el('p', { className: 'hvir-meta note' }, branchNote(snapshot)))
  list.append(...section.rows.map((row) => pullRow(row, snapshot, now)))
  return details
}

/** Why a connector can't serve this workspace: never approved, or approved for another host. */
function hostNote(connector, connectors, workspace) {
  return (
    connectors[connector] === 'other-host'
      ? `${connector} is approved for ${connectors.hosts[connector].join(', ')}, not ${workspace.host}. ${
          connectors.freeSlot[connector]
            ? `Approve ${connectors.freeSlot[connector]} for ${workspace.host}`
            : `All ${connector} host slots are in use; revoke one and approve it for ${workspace.host}`
        } in Settings → Extensions.`
      : `${connector} is not connected for this workspace host.`
  )
}

const openPull = (repo) => (option) =>
  window.openOwn('pull', { repo, number: Number(option.dataset.number) }).catch((error) => setStatus(error.message))

function render(snapshot, now) {
  for (const binding of lists) binding.dispose()
  const sections = pullSections(snapshot, now).filter((section) => section.key === 'branch' || section.rows.length > 0)
  ui.sections.replaceChildren(...sections.map((section) => renderSection(section, snapshot, now)))
  lists = [...ui.sections.querySelectorAll('[role="listbox"]')].map((list) =>
    window.hvirUI.bindList(list, openPull(snapshot.repo)),
  )
  if (sections.length === 1 && sections[0].rows.length === 0)
    ui.sections.append(el('p', { className: 'hvir-meta note' }, 'Nothing open that is yours or waiting on you.'))
  ui.repo.textContent = snapshot.repo
  const capped = snapshot.hasMore && limit >= MAX_LIMIT
  ui.more.hidden = !snapshot.hasMore || capped
  setStatus(capped ? `Showing the first ${MAX_LIMIT} of each list. Open GitHub for the rest.` : '')
}

/** The header count belongs to the updater (cross-workspace); this view only renders. */
async function load(context, current) {
  if (!context.workspace) return setStatus('No workspace selected')
  if (context.workspace.id !== workspaceId) {
    workspaceId = context.workspace.id
    limit = PAGE_SIZE
  }
  const connectors = await availability({ workspace: context.workspace })
  ui['connect-gh'].hidden = connectors.gh === 'supported'
  ui['connect-git'].hidden = connectors.git === 'supported'
  if (connectors.gh !== 'supported') return setStatus(hostNote('gh', connectors, context.workspace))
  gitNote = connectors.git === 'other-host'
    ? hostNote('git', connectors, context.workspace)
    : 'Connect git to show the pull request for this branch.'
  ui.refresh.disabled = true
  try {
    const requested = limit
    const snapshot = await window.pullsSource.snapshot(context.workspace, requested, connectors.git === 'supported')
    if (current().workspace?.id !== context.workspace.id || requested !== limit) return
    render(snapshot, Date.now())
  } finally {
    ui.refresh.disabled = false
  }
}

const view = window.startView({ load, refreshMs: REFRESH_MS, onStatus: setStatus })
ui.refresh.addEventListener('click', () => void view.refresh())
ui.more.addEventListener('click', () => {
  limit = Math.min(limit + PAGE_SIZE, MAX_LIMIT)
  void view.refresh()
})
ui['connect-gh'].addEventListener('click', window.connectHandler('gh', setStatus, view.refresh))
ui['connect-git'].addEventListener('click', window.connectHandler('git', setStatus, view.refresh))
