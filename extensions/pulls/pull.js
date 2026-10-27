/* global window, document */
const { run, availability, request } = window.host
const { el } = window
const { WORKTREE_ARGS, worktreeOf } = window.worktrees
const {
  labelLogBatches,
  parseLabelLog,
  commitLabelRows,
  labelChips,
  labelSummary,
  isPartialClone,
  CONFIG_NAMES,
} = window.commitLabels
const ui = Object.fromEntries(
  [
    'title',
    'meta',
    'url',
    'status',
    'checkout',
    'checkout-note',
    'checkout-status',
    'commits-section',
    'commits-heading',
    'commits-note',
    'commits',
    'checks-section',
    'checks-heading',
    'checks',
    'reviews-section',
    'reviews',
    'threads-section',
    'threads-heading',
    'threads',
    'comments-section',
    'comments',
    'body-section',
    'body',
    'explainer-section',
    'explainer-note',
    'explainer',
  ].map((id) => [id, document.getElementById(id)]),
)
const VIEW_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'author',
  'headRefName',
  'baseRefName',
  'body',
  'additions',
  'deletions',
  'changedFiles',
  'reviewDecision',
  'reviewRequests',
  'latestReviews',
  'comments',
  'statusCheckRollup',
  'commits',
  'isCrossRepository',
  'headRefOid',
].join(',')
/** Check runs report `conclusion`; legacy status contexts report `state`. */
const checkResult = (check) =>
  (check.conclusion || check.state || check.status || 'pending').toLowerCase()
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
    body ? window.markdown.render(body) : null,
  )

function renderChecks(checks) {
  const results = checks.map(checkResult)
  const counts = [...new Set(results)].map(
    (result) => `${results.filter((r) => r === result).length} ${result}`,
  )
  ui['checks-heading'].textContent = `Checks · ${counts.join(', ')}`
  const notable = checks.filter(
    (check) => !['success', 'skipped', 'neutral'].includes(checkResult(check)),
  )
  fill(
    'checks-section',
    'checks',
    notable.map((check) =>
      line(check.name || check.context || 'check', checkResult(check)),
    ),
  )
  if (checks.length > 0) ui['checks-section'].hidden = false
}

function renderReviews(pull) {
  const requested = (pull.reviewRequests ?? []).map((request) =>
    line(`@${request.login ?? request.slug ?? request.name}`, 'review requested'),
  )
  const reviews = (pull.latestReviews ?? []).map((review) =>
    line(
      `@${review.author?.login ?? 'unknown'}`,
      `${review.state.toLowerCase()} · ${window.ago(review.submittedAt)}`,
    ),
  )
  fill('reviews-section', 'reviews', [...requested, ...reviews])
}

/** Review threads come from a second, optional query; its failure is a note, not a blank view. */
function renderThreads(detail) {
  if (detail.error) {
    ui['threads-heading'].textContent =
      `Review threads · unavailable: ${detail.error.message}`
    fill('threads-section', 'threads', [])
    ui['threads-section'].hidden = false
    return
  }
  const threads = detail.value?.data?.repository?.pullRequest?.reviewThreads
  const nodes = threads?.nodes ?? []
  const open = nodes.filter((thread) => !thread.isResolved && !thread.isOutdated).length
  const more = threads?.pageInfo?.hasNextPage ? '+' : ''
  ui['threads-heading'].textContent =
    `Review threads · ${open} open of ${nodes.length}${more}`
  fill(
    'threads-section',
    'threads',
    nodes.map((thread) => {
      const [first] = thread.comments?.nodes ?? []
      const state = [
        thread.isResolved ? 'resolved' : 'open',
        thread.isOutdated ? 'outdated' : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const where = `${thread.path ?? 'location unknown'}${thread.line ? `:${thread.line}` : ''}`
      return line(
        where,
        `${state}${first?.author ? ` · @${first.author.login}` : ''}`,
        first?.body ?? '',
      )
    }),
  )
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
  ]
    .filter(Boolean)
    .join(' · ')
  ui.url.replaceChildren(
    pull.url,
    ' ',
    window.githubLink(pull.url, (text) => (ui.status.textContent = text)) ?? '',
  )
  renderChecks(pull.statusCheckRollup ?? [])
  renderReviews(pull)
  renderThreads(detail)
  fill(
    'comments-section',
    'comments',
    (pull.comments ?? []).map((comment) =>
      line(
        `@${comment.author?.login ?? 'unknown'}`,
        window.ago(comment.createdAt),
        comment.body,
      ),
    ),
  )
  ui.body.replaceChildren(...(pull.body ? [window.markdown.render(pull.body)] : []))
  ui['body-section'].hidden = !pull.body
}

/** Which pull request a context shows; a workspace change is a different view even for the same number. */
function keyOf(context) {
  const { repo, number } = context?.input ?? {}
  if (
    typeof repo !== 'string' ||
    !window.REPO_NAME.test(repo) ||
    !Number.isInteger(number) ||
    number < 1
  )
    return undefined
  return `${context.workspace?.id}|${repo}#${number}`
}

/**
 * Labels for the pull request's commits from this checkout. Commits that are not local are
 * reported, never fetched (a partial clone would fetch them on demand without --no-lazy-fetch).
 * Failure is a note in the section, not a blank view.
 */
async function readLabels(workspace, commits, connectors) {
  if (commits.length === 0) return { rows: [] }
  if (connectors.git !== 'supported')
    return {
      note: `Change-type labels need git. ${window.hostNote('git', workspace)}`,
    }
  try {
    const partialClone = isPartialClone(
      await run('git', workspace, CONFIG_NAMES, { text: true }),
    )
    const outputs = []
    for (const args of labelLogBatches(
      commits.map((commit) => commit.oid),
      partialClone,
    ))
      outputs.push(await run('git', workspace, args, { text: true }))
    const found = new Map(outputs.flatMap((output) => [...parseLabelLog(output)]))
    return { rows: commitLabelRows(commits, found) }
  } catch (error) {
    return { error }
  }
}

function commitLine(row) {
  const chips =
    row.state === 'missing'
      ? [el('span', {}, 'not in this checkout')]
      : (row.label ? labelChips(row.label) : []).map((chip) =>
          el('span', { className: 'chip' }, chip),
        )
  return el(
    'li',
    { className: 'line' },
    el('span', {}, `${row.short} ${row.headline}`),
    chips.length ? el('span', { className: 'hvir-meta chips' }, ...chips) : null,
  )
}

function renderCommits(labels) {
  const quiet = (note) => {
    ui['commits-heading'].textContent = 'Commits'
    ui['commits-note'].textContent = note
    ui['commits-note'].hidden = false
    fill('commits-section', 'commits', [])
    ui['commits-section'].hidden = false
  }
  if (labels.error)
    return quiet(`Change-type labels unavailable: ${labels.error.message}`)
  if (labels.note) return quiet(labels.note)
  const { rows } = labels
  if (rows.length === 0) return fill('commits-section', 'commits', [])
  if (!rows.some((row) => row.state === 'labeled')) return quiet(labelSummary(rows))
  ui['commits-heading'].textContent = `Commits · ${labelSummary(rows)}`
  ui['commits-note'].hidden = true
  fill('commits-section', 'commits', rows.map(commitLine))
}

/**
 * Where the pull request's branch is already checked out. Only same-repository pull requests are
 * checked: gh names a fork's local branch itself, so a matching name there may be another branch.
 */
async function checkedOut(workspace, pull, connectors) {
  if (pull.isCrossRepository || connectors.git !== 'supported') return {}
  try {
    const path = worktreeOf(
      await run('git', workspace, WORKTREE_ARGS, { text: true }),
      pull.headRefName,
    )
    return { path, here: path !== undefined && path === workspace.root?.path }
  } catch (error) {
    return { error }
  }
}

function checkoutNote(existing) {
  if (existing.here) return 'This workspace already has the branch checked out.'
  if (existing.path)
    return `Already checked out in ${existing.path.split('/').at(-1)} (${existing.path}). Select it in the sidebar, or open a terminal there from the Pull requests list.`
  if (existing.error)
    return `Could not list worktrees, so a checkout may fail: ${existing.error.message}`
  return ''
}

function renderCheckout(repo, number, existing) {
  const note = checkoutNote(existing)
  ui.checkout.hidden = existing.path !== undefined
  ui.checkout.dataset.number = String(number)
  ui.checkout.dataset.repo = repo
  ui['checkout-note'].hidden = note === ''
  ui['checkout-note'].textContent = note
}

/** Run a terminal action from `button`; hvir asks the person to confirm before anything starts. */
async function launch(button, action, input, started) {
  button.disabled = true
  ui['checkout-status'].textContent = 'Waiting for your confirmation…'
  try {
    const result = await request('actions.invoke', { action, input })
    ui['checkout-status'].textContent = window.terminalOutcome(result, started)
  } catch (error) {
    ui['checkout-status'].textContent = error.message
  } finally {
    button.disabled = false
  }
}

function checkout() {
  const number = Number(ui.checkout.dataset.number)
  const { repo } = ui.checkout.dataset
  return launch(
    ui.checkout,
    'checkout-terminal',
    { repo, number },
    `Opened a terminal running gh pr checkout ${number} -R ${repo}.`,
  )
}

let explainerShown

async function renderExplainer(workspace, body, key) {
  const url = window.explainer.explainerUrl(body)
  if (url === undefined) {
    explainerShown = undefined
    ui['explainer-section'].hidden = true
    return
  }
  if (explainerShown === url) return
  explainerShown = url
  ui['explainer-section'].hidden = false
  ui['explainer-note'].hidden = false
  ui['explainer-note'].textContent = 'Loading the explainer…'
  try {
    const html = await run('gh', workspace, ['api', url], { text: true })
    if (shownKey !== key) return
    window.explainer.mount(ui.explainer, html)
    ui['explainer-note'].hidden = true
  } catch (error) {
    if (shownKey !== key) return
    ui['explainer-note'].textContent = `Explainer unavailable (${error.message}): ${url}`
  }
}

/** What a previous pull request left on screen must not read as this one's. */
let shownKey
function clearShown(key) {
  shownKey = key
  ui.checkout.hidden = true
  ui['checkout-note'].hidden = true
  ui['checkout-status'].textContent = ''
  ui['commits-section'].hidden = true
  ui['explainer-section'].hidden = true
  ui.explainer.shadowRoot?.replaceChildren()
  explainerShown = undefined
}

let citySignature

async function loadCity(workspace, repo, pull, connectors, key) {
  const found = await window.citySource.runs(workspace, repo, { number: pull.number, headRef: pull.headRefName }, connectors)
  const packages = new Map()
  for (const run of found.runs) packages.set(run.id, await window.citySource.reviewPackage(workspace, run, connectors))
  const signature = JSON.stringify([key, found, [...packages.keys()], [...packages.values()].map((entry) => Boolean(entry.pkg))])
  if (signature === citySignature) return
  citySignature = signature
  window.reviewPage.setCity(key, { ...found, packages })
}

let diffShown

async function readDiff(workspace, repo, number, head, key) {
  if (diffShown?.key === key && diffShown.head === head) return diffShown.result
  try {
    const text = await run('gh', workspace, ['pr', 'diff', String(number), '-R', repo], {
      text: true,
    })
    diffShown = {
      key,
      head,
      result: {
        files: window.diffParse.parseDiff(text),
        diffError: undefined,
        diffHead: head,
      },
    }
  } catch (error) {
    diffShown = {
      key,
      head,
      result: { files: [], diffError: error.message, diffHead: undefined },
    }
  }
  return diffShown.result
}

async function load(context, current) {
  const key = keyOf(context)
  if (key === undefined) {
    ui.title.textContent = 'No pull request selected'
    return
  }
  const { repo, number } = context.input
  if (key !== shownKey) clearShown(key)
  const connectors = await availability({ workspace: context.workspace })
  if (connectors.gh !== 'supported') {
    ui.status.textContent = window.hostNote('gh', context.workspace)
    return
  }
  await window.reviewPage.load({
    key,
    repo,
    number,
    workspace: context.workspace,
    connectors,
  })
  const [pull, detail] = await Promise.all([
    run('gh', context.workspace, [
      'pr',
      'view',
      String(number),
      '-R',
      repo,
      '--json',
      VIEW_FIELDS,
    ]),
    run('gh', context.workspace, window.pullQuery.pullDetailQueryArgs(repo, number)).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
  ])
  if (keyOf(current()) !== key) return
  ui.status.textContent = ''
  render(pull, detail)
  const diff = await readDiff(context.workspace, repo, number, pull.headRefOid, key)
  if (keyOf(current()) !== key) return
  window.reviewPage.show({ key, pull, detail: detail.value, ...diff })
  void loadCity(context.workspace, repo, pull, connectors, key)
  void renderExplainer(context.workspace, pull.body, key)
  const existing = await checkedOut(context.workspace, pull, connectors)
  if (keyOf(current()) !== key) return
  renderCheckout(repo, number, existing)
  const labels = await readLabels(context.workspace, pull.commits ?? [], connectors)
  if (keyOf(current()) !== key) return
  renderCommits(labels)
}

const setStatus = (text) => (ui.status.textContent = text)
window.reviewPage.setStatusHandler(setStatus)
window.pullView = window.startView({ load, refreshMs: REFRESH_MS, onStatus: setStatus })
document
  .getElementById('connect-store')
  .addEventListener(
    'click',
    window.connectHandler(
      window.reviewStore.CONNECTOR,
      setStatus,
      window.pullView.refresh,
    ),
  )
ui.checkout.addEventListener('click', () => void checkout())
