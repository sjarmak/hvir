/* global window, document */
const { availability } = window.host
const { el } = window
const { pullSections, age, badges, reasonTone, activitySignal, stackSummary, roleLabel } = window.pullsModel
const { pullHandle } = window.pullWaits
const ui = Object.fromEntries(
  ['repo', 'refresh', 'status', 'connect-gh', 'connect-git', 'connect-shell', 'sections', 'more'].map((id) => [id, document.getElementById(id)]),
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

const STACK_HUES = 4

function tonedChip(label, tone, className = 'chip') {
  const chip = el('span', { className }, label)
  chip.dataset.tone = tone
  return chip
}

function stackChip(stack) {
  const summary = stackSummary(stack)
  if (summary === undefined) return null
  const chip = el(
    'span',
    { className: 'chip chip-stack', title: `Stack order: ${summary.order.map((number) => `#${number}`).join(' → ')}` },
    summary.label,
  )
  chip.dataset.hue = String(summary.id % STACK_HUES)
  return chip
}

function activityChips(pull, now) {
  const signal = activitySignal(pull, now)
  if (signal === undefined)
    return [el('span', { className: 'chip-updated', title: new Date(pull.updatedAt).toLocaleString() }, `updated ${window.ago(pull.updatedAt)}`)]
  const chip = tonedChip(`${signal.label} · ${window.ago(pull.activity.at)}`, signal.tone, 'chip chip-activity')
  chip.title = new Date(signal.at).toLocaleString()
  chip.dataset.fresh = String(signal.fresh)
  const unseen = signal.newCount > 0 ? el('span', { className: 'chip chip-new', title: 'Reviews and comments since you last acted' }, `${signal.newCount} new`) : null
  return [chip, unseen]
}

function pullRow(row, snapshot, now, here) {
  const { pull, reason, since, waitingOn, stack } = row
  const worktree = window.worktreeControl.worktreeFor(here.worktrees, pull, snapshot.repo)
  const role = roleLabel(row)
  const chips = [
    stackChip(stack),
    role ? el('span', { className: 'chip chip-role' }, role) : null,
    reason ? tonedChip(reason, reasonTone(reason), 'chip chip-reason') : null,
    ...activityChips(pull, now),
    ...badges(row).map((badge) => tonedChip(badge.label, badge.tone)),
    since === undefined ? null : ageChip(since, now),
    pull.author && pull.author !== snapshot.viewer ? el('span', {}, `@${pull.author}`) : null,
    waitingOn.length ? el('span', {}, `waiting on ${waitingOn.map(pullHandle).join(', ')}`) : null,
    worktree ? window.worktreeControl.chip(worktree, here.shell, setStatus) : null,
  ].filter(Boolean)
  const option = window.optionRow({
    title: `#${pull.number} ${pull.title}`,
    hover: `${pull.headRef} → ${pull.baseRef} · ${pull.url}`,
    meta: chips,
    data: { number: String(pull.number) },
  })
  if (stack !== undefined) {
    option.dataset.hue = String(stack.id % STACK_HUES)
    option.style.setProperty('--stack-depth', String(stack.depth))
    option.classList.add('stacked')
  }
  return option
}

function issueRow(row, snapshot) {
  const { issue } = row
  const chips = [
    el('span', { className: 'chip chip-role' }, roleLabel(row)),
    el('span', { className: 'chip-updated', title: new Date(issue.updatedAt).toLocaleString() }, `updated ${window.ago(issue.updatedAt)}`),
    ...issue.labels.map((label) => el('span', { className: 'chip chip-label' }, label)),
    issue.comments > 0 ? el('span', {}, `${issue.comments} ${issue.comments === 1 ? 'comment' : 'comments'}`) : null,
    issue.author && issue.author !== snapshot.viewer ? el('span', {}, `@${issue.author}`) : null,
  ].filter(Boolean)
  return window.optionRow({
    title: `#${issue.number} ${issue.title}`,
    hover: issue.url,
    meta: chips,
    data: { number: String(issue.number), kind: 'issue' },
  })
}

function ageChip(since, now) {
  const { label, tone } = age(since, now)
  const chip = el('span', { className: 'chip chip-age', title: `Waiting since ${new Date(since).toLocaleString()}` }, label)
  chip.dataset.tone = tone
  return chip
}

function branchNote(snapshot) {
  if (!snapshot.gitChecked) return gitNote
  return snapshot.branch === undefined
    ? 'Detached HEAD, so no branch pull request.'
    : `No pull request for ${snapshot.branch}.`
}

function renderSection(section, snapshot, now, here) {
  const list = el('div', { role: 'listbox' })
  list.setAttribute('aria-label', section.label)
  list.dataset.section = section.key
  const summary = el('summary', {}, `${section.label} · ${section.rows.length}`)
  const details = el('details', { open: !collapsed.has(section.key) }, summary, list)
  details.addEventListener('toggle', () => (details.open ? collapsed.delete(section.key) : collapsed.add(section.key)))
  if (section.rows.length === 0) list.append(el('p', { className: 'hvir-meta note' }, branchNote(snapshot)))
  list.append(
    ...section.rows.map((row) =>
      section.key === 'issues' ? issueRow(row, snapshot) : pullRow(row, snapshot, now, here),
    ),
  )
  return details
}

const openRow = (repo) => (option) =>
  window
    .openOwn(option.dataset.kind === 'issue' ? 'issue' : 'pull', { repo, number: Number(option.dataset.number) })
    .catch((error) => setStatus(error.message))

/** `here` is the other worktrees of this checkout and the shell connector's availability. */
function render(snapshot, now, here) {
  for (const binding of lists) binding.dispose()
  const sections = pullSections(snapshot, now).filter((section) => section.key === 'branch' || section.rows.length > 0)
  ui.sections.replaceChildren(...sections.map((section) => renderSection(section, snapshot, now, here)))
  lists = [...ui.sections.querySelectorAll('[role="listbox"]')].map((list) =>
    window.hvirUI.bindList(list, openRow(snapshot.repo)),
  )
  if (sections.length === 1 && sections[0].rows.length === 0)
    ui.sections.append(
      el('p', { className: 'hvir-meta note' }, 'No open pull requests of yours, review requests or assigned issues.'),
    )
  ui.repo.textContent = snapshot.repo
  const capped = snapshot.hasMore && limit >= MAX_LIMIT
  ui.more.hidden = !snapshot.hasMore || capped
  const elsewhere = sections
    .filter((section) => section.key !== 'issues')
    .some((section) =>
      section.rows.some((row) => window.worktreeControl.worktreeFor(here.worktrees, row.pull, snapshot.repo)),
    )
  ui['connect-shell'].hidden = !elsewhere || here.shell === 'supported'
  setStatus(
    [capped ? `Showing the first ${MAX_LIMIT} of each list. Open GitHub for the rest.` : '', here.note]
      .filter(Boolean)
      .join(' '),
  )
}

/** The header count belongs to the updater (cross-workspace); this view only renders. */
async function load(context, current) {
  if (!context.workspace) return setStatus('No workspace selected')
  if (context.workspace.id !== workspaceId) {
    workspaceId = context.workspace.id
    limit = PAGE_SIZE
  }
  const connectors = await availability({ workspace: context.workspace })
  const local = context.workspace.host === 'local'
  ui['connect-gh'].hidden = connectors.gh === 'supported' || !local
  ui['connect-git'].hidden = connectors.git === 'supported' || !local
  if (connectors.gh !== 'supported') return setStatus(window.hostNote('gh', context.workspace))
  gitNote = 'Connect git to show the pull request for this branch.'
  ui.refresh.disabled = true
  try {
    const requested = limit
    const snapshot = await window.pullsSource.snapshot(context.workspace, requested, connectors.git === 'supported')
    const here = await window.worktreeControl.readWorktrees(context.workspace, connectors).then(
      (worktrees) => ({ worktrees, shell: connectors.shell, note: '' }),
      (error) => ({ worktrees: new Map(), shell: connectors.shell, note: `Worktrees unavailable: ${error.message}` }),
    )
    if (current().workspace?.id !== context.workspace.id || requested !== limit) return
    render(snapshot, Date.now(), here)
    if (!local) ui['connect-shell'].hidden = true
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
ui['connect-shell'].addEventListener('click', window.connectHandler('shell', setStatus, view.refresh))
