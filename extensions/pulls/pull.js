/* global window, document */
const { run } = window.host
const { el } = window
const ui = Object.fromEntries(
  [
    'title', 'meta', 'url', 'status', 'checks-section', 'checks-heading', 'checks', 'reviews-section', 'reviews',
    'threads-section', 'threads-heading', 'threads', 'comments-section', 'comments', 'body-section', 'body',
  ].map((id) => [id, document.getElementById(id)]),
)
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const VIEW_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'author', 'headRefName', 'baseRefName', 'body', 'additions',
  'deletions', 'changedFiles', 'reviewDecision', 'reviewRequests', 'latestReviews', 'comments', 'statusCheckRollup',
].join(',')
/** Check runs report `conclusion`; legacy status contexts report `state`. */
const checkResult = (check) => (check.conclusion || check.state || check.status || 'pending').toLowerCase()
/** Same cadence as the list view, so an open detail tab does not go stale. */
const REFRESH_MS = 60 * 1000

function fill(sectionId, listId, items) {
  ui[listId].replaceChildren(...items)
  ui[sectionId].hidden = items.length === 0
}

const line = (head, meta, body) =>
  el(
    'li',
    { className: 'line' },
    el('span', {}, head),
    meta ? el('span', { className: 'hvir-meta' }, meta) : null,
    body ? el('span', { className: 'prose' }, body) : null,
  )

function renderChecks(checks) {
  const results = checks.map(checkResult)
  const counts = [...new Set(results)].map((result) => `${results.filter((r) => r === result).length} ${result}`)
  ui['checks-heading'].textContent = `Checks · ${counts.join(', ')}`
  const notable = checks.filter((check) => !['success', 'skipped', 'neutral'].includes(checkResult(check)))
  fill('checks-section', 'checks', notable.map((check) => line(check.name || check.context || 'check', checkResult(check))))
  if (checks.length > 0) ui['checks-section'].hidden = false
}

function renderReviews(pull) {
  const requested = (pull.reviewRequests ?? []).map((request) =>
    line(`@${request.login ?? request.slug ?? request.name}`, 'review requested'))
  const reviews = (pull.latestReviews ?? []).map((review) =>
    line(`@${review.author?.login ?? 'unknown'}`, `${review.state.toLowerCase()} · ${window.ago(review.submittedAt)}`))
  fill('reviews-section', 'reviews', [...requested, ...reviews])
}

/** Review threads come from a second, optional query; its failure is a note, not a blank view. */
function renderThreads(detail) {
  if (detail.error) {
    ui['threads-heading'].textContent = `Review threads · unavailable: ${detail.error.message}`
    fill('threads-section', 'threads', [])
    ui['threads-section'].hidden = false
    return
  }
  const threads = detail.value?.data?.repository?.pullRequest?.reviewThreads
  const nodes = threads?.nodes ?? []
  const open = nodes.filter((thread) => !thread.isResolved && !thread.isOutdated).length
  const more = threads?.pageInfo?.hasNextPage ? '+' : ''
  ui['threads-heading'].textContent = `Review threads · ${open} open of ${nodes.length}${more}`
  fill('threads-section', 'threads', nodes.map((thread) => {
    const [first] = thread.comments?.nodes ?? []
    const state = [thread.isResolved ? 'resolved' : 'open', thread.isOutdated ? 'outdated' : ''].filter(Boolean).join(' · ')
    const where = `${thread.path ?? 'location unknown'}${thread.line ? `:${thread.line}` : ''}`
    return line(where, `${state}${first?.author ? ` · @${first.author.login}` : ''}`, first?.body ?? '')
  }))
}

function render(pull, detail) {
  document.title = `#${pull.number}`
  ui.title.textContent = `#${pull.number} ${pull.title}`
  ui.meta.textContent = [
    pull.isDraft ? 'draft' : pull.state.toLowerCase(),
    `@${pull.author?.login ?? 'unknown'}`,
    `${pull.headRefName} → ${pull.baseRefName}`,
    `+${pull.additions} −${pull.deletions} in ${pull.changedFiles} files`,
    pull.reviewDecision ? pull.reviewDecision.toLowerCase().replaceAll('_', ' ') : '',
  ].filter(Boolean).join(' · ')
  ui.url.textContent = pull.url
  renderChecks(pull.statusCheckRollup ?? [])
  renderReviews(pull)
  renderThreads(detail)
  fill('comments-section', 'comments', (pull.comments ?? []).map((comment) =>
    line(`@${comment.author?.login ?? 'unknown'}`, window.ago(comment.createdAt), comment.body)))
  ui.body.textContent = pull.body ?? ''
  ui['body-section'].hidden = !pull.body
}

/** Which pull request a context shows; a workspace change is a different view even for the same number. */
function keyOf(context) {
  const { repo, number } = context?.input ?? {}
  if (typeof repo !== 'string' || !REPO.test(repo) || !Number.isInteger(number) || number < 1) return undefined
  return `${context.workspace?.id}|${repo}#${number}`
}

async function load(context, current) {
  const key = keyOf(context)
  if (key === undefined) {
    ui.title.textContent = 'No pull request selected'
    return
  }
  const { repo, number } = context.input
  const [pull, detail] = await Promise.all([
    run('gh', context.workspace, ['pr', 'view', String(number), '-R', repo, '--json', VIEW_FIELDS]),
    run('gh', context.workspace, window.pullQuery.pullDetailQueryArgs(repo, number)).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
  ])
  if (keyOf(current()) !== key) return
  ui.status.textContent = ''
  render(pull, detail)
}

window.startView({ load, refreshMs: REFRESH_MS, onStatus: (text) => (ui.status.textContent = text) })
