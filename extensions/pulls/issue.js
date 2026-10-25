/* global window, document */
const { run, availability } = window.host
const { el } = window
const ui = Object.fromEntries(
  ['title', 'meta', 'labels', 'url', 'status', 'body-section', 'body', 'comments-section', 'comments-heading', 'comments'].map(
    (id) => [id, document.getElementById(id)],
  ),
)
const VIEW_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'stateReason',
  'author',
  'body',
  'labels',
  'assignees',
  'milestone',
  'comments',
  'createdAt',
  'updatedAt',
].join(',')
const REFRESH_MS = 60 * 1000

const line = (head, meta, body) =>
  el(
    'li',
    { className: 'line' },
    el('span', {}, head),
    meta ? el('span', { className: 'hvir-meta' }, meta) : null,
    body ? window.markdown.render(body) : null,
  )

function render(issue) {
  document.title = `#${issue.number}`
  ui.title.textContent = `#${issue.number} ${issue.title}`
  const assignees = (issue.assignees ?? []).map((user) => `@${user.login}`)
  ui.meta.textContent = [
    issue.state.toLowerCase(),
    issue.stateReason ? issue.stateReason.toLowerCase().replaceAll('_', ' ') : '',
    `@${issue.author?.login ?? 'unknown'}`,
    `opened ${window.ago(issue.createdAt)}`,
    issue.milestone?.title ? `milestone ${issue.milestone.title}` : '',
    assignees.length ? `assigned to ${assignees.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const labels = (issue.labels ?? []).map((label) => el('span', { className: 'chip chip-label' }, label.name))
  ui.labels.replaceChildren(...labels)
  ui.labels.hidden = labels.length === 0
  ui.url.textContent = issue.url
  ui.body.replaceChildren(...(issue.body ? [window.markdown.render(issue.body)] : []))
  ui['body-section'].hidden = !issue.body
  const comments = issue.comments ?? []
  ui['comments-heading'].textContent = `Conversation · ${comments.length}`
  ui.comments.replaceChildren(
    ...comments.map((comment) =>
      line(`@${comment.author?.login ?? 'unknown'}`, window.ago(comment.createdAt), comment.body),
    ),
  )
  ui['comments-section'].hidden = comments.length === 0
}

function keyOf(context) {
  const { repo, number } = context?.input ?? {}
  if (typeof repo !== 'string' || !window.REPO_NAME.test(repo) || !Number.isInteger(number) || number < 1)
    return undefined
  return `${context.workspace?.id}|${repo}#${number}`
}

async function load(context, current) {
  const key = keyOf(context)
  if (key === undefined) {
    ui.title.textContent = 'No issue selected'
    return
  }
  const { repo, number } = context.input
  const connectors = await availability({ workspace: context.workspace })
  if (connectors.gh !== 'supported') {
    ui.status.textContent = window.hostNote('gh', context.workspace)
    return
  }
  const issue = await run('gh', context.workspace, ['issue', 'view', String(number), '-R', repo, '--json', VIEW_FIELDS])
  if (keyOf(current()) !== key) return
  ui.status.textContent = ''
  render(issue)
}

window.startView({
  load,
  refreshMs: REFRESH_MS,
  onStatus: (text) => (ui.status.textContent = text),
})
