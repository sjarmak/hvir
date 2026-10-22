/* global window */
/**
 * Agent actions for the pulls view. hvir opens this view hidden to run them, so every connector
 * request carries the invocation id. Results stay under the 8 KiB action bound (actionBytes):
 * rows are compact and dropped from the end, with the drop count reported, when they would not fit.
 */
;(() => {
  const bridge = window.hvirExtension
  const { pullSections, age } = window.pullsModel
  const { pullHandle } = window.pullWaits
  const RESULT_BYTES = 7 * 1024
  const TITLE_CHARS = 120
  const SECTIONS = ['branch', 'needs', 'issues', 'waiting', 'drafts']
  const STATUS_FIELDS =
    'number,title,url,state,isDraft,author,headRefName,reviewDecision,reviewRequests,statusCheckRollup'
  /** Check runs report `conclusion`; legacy status contexts report `state`. */
  const checkResult = (check) =>
    (check.conclusion || check.state || check.status || 'pending').toLowerCase()

  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

  function fit(result, key) {
    const rows = [...result[key]]
    let omitted = result.omitted ?? 0
    while (rows.length && bytes({ ...result, [key]: rows, omitted }) > RESULT_BYTES) {
      rows.pop()
      omitted += 1
    }
    return { ...result, [key]: rows, omitted }
  }

  function compactRow(row, section, now) {
    const { pull, reason, since, waitingOn, role } = row
    return {
      number: pull.number,
      title: pull.title.slice(0, TITLE_CHARS),
      section,
      role,
      ...(reason ? { reason } : {}),
      ...(since === undefined
        ? {}
        : { waiting: age(since, now).label, since: new Date(since).toISOString() }),
      ...(pull.author ? { author: pull.author } : {}),
      ...(waitingOn.length ? { waitingOn: waitingOn.map(pullHandle) } : {}),
      url: pull.url,
    }
  }

  function compactIssue(row, now) {
    const { issue, since, role } = row
    return {
      number: issue.number,
      title: issue.title.slice(0, TITLE_CHARS),
      section: 'issues',
      role,
      waiting: age(since, now).label,
      since: new Date(since).toISOString(),
      ...(issue.author ? { author: issue.author } : {}),
      ...(issue.labels.length ? { labels: issue.labels } : {}),
      ...(issue.comments ? { comments: issue.comments } : {}),
      url: issue.url,
    }
  }

  async function listPulls(input, context, actionId) {
    const section = input?.section
    if (section !== undefined && !SECTIONS.includes(section))
      throw new Error(`section must be one of ${SECTIONS.join(', ')}`)
    const limit = input?.limit ?? 30
    const connectors = await window.host.availability({
      actionId,
      workspace: context.workspace,
    })
    if (connectors.gh !== 'supported')
      throw new Error(`gh is not approved for host ${context.workspace.host}`)
    const useGit = connectors.git === 'supported'
    const snapshot = await window.pullsSource.snapshot(
      context.workspace,
      limit,
      useGit,
      actionId,
    )
    const now = Date.now()
    const sections = pullSections(snapshot, now).filter(
      (entry) => section === undefined || entry.key === section,
    )
    const pulls = sections
      .filter((entry) => entry.key !== 'issues')
      .flatMap((entry) => entry.rows.map((row) => compactRow(row, entry.key, now)))
    const issues = sections
      .filter((entry) => entry.key === 'issues')
      .flatMap((entry) => entry.rows.map((row) => compactIssue(row, now)))
    return fit(
      fit(
        {
          repo: snapshot.repo,
          viewer: snapshot.viewer,
          hasMore: snapshot.hasMore,
          branchChecked: useGit,
          pulls,
          issues,
        },
        'pulls',
      ),
      'issues',
    )
  }

  function checkSummary(checks) {
    const counts = {}
    for (const check of checks) {
      const result = checkResult(check)
      counts[result] = (counts[result] ?? 0) + 1
    }
    const failing = checks
      .filter((check) =>
        ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(
          checkResult(check),
        ),
      )
      .map((check) => check.name || check.context)
      .slice(0, 10)
    return { counts, failing }
  }

  async function pullStatus(input, context, actionId) {
    const number = input?.number
    if (!Number.isInteger(number) || number < 1)
      throw new Error('number must be a positive integer')
    const repo = await window.pullsSource.repoFor(context.workspace, actionId)
    const pull = await window.host.run(
      'gh',
      context.workspace,
      ['pr', 'view', String(number), '-R', repo, '--json', STATUS_FIELDS],
      { actionId },
    )
    const requested = (pull.reviewRequests ?? [])
      .map((entry) => entry.login || entry.name || entry.slug)
      .filter(Boolean)
    return fit(
      {
        repo,
        number: pull.number,
        title: pull.title.slice(0, TITLE_CHARS),
        url: pull.url,
        state: pull.state,
        draft: pull.isDraft,
        author: pull.author?.login,
        branch: pull.headRefName,
        reviewDecision: pull.reviewDecision || 'NONE',
        checks: checkSummary(pull.statusCheckRollup ?? []),
        reviewRequests: requested,
      },
      'reviewRequests',
    )
  }

  /**
   * hvir confirms each launch and runs it on the workspace's host, so gh must be approved for
   * that host (src/main/extensions/terminal-handoff.ts).
   */
  async function checkoutTerminal(input, context, actionId) {
    const { repo, number } = input ?? {}
    if (typeof repo !== 'string' || !window.REPO_NAME.test(repo))
      throw new Error('repo must be owner/name')
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error('number must be a positive integer')
    return window.host.terminal(
      'gh',
      context.workspace,
      ['pr', 'checkout', String(number), '-R', repo],
      actionId,
    )
  }

  /**
   * A terminal in another worktree of this repository, standing in for selecting that workspace.
   * The path must be one `git worktree list` reports, so the input cannot name another directory.
   */
  async function worktreeTerminal(input, context, actionId) {
    const path = input?.path
    if (typeof path !== 'string' || !path.startsWith('/'))
      throw new Error('path must be absolute')
    const listing = await window.host.run(
      'git',
      context.workspace,
      window.worktrees.WORKTREE_ARGS,
      {
        text: true,
        actionId,
      },
    )
    if (!window.worktrees.worktreePaths(listing).includes(path))
      throw new Error(`${path} is not a worktree of this repository`)
    return window.host.terminal(
      'shell',
      context.workspace,
      window.worktrees.shellArgs(path),
      actionId,
    )
  }

  const HANDLERS = {
    'list-pulls': listPulls,
    'pull-status': pullStatus,
    'checkout-terminal': checkoutTerminal,
    'worktree-terminal': worktreeTerminal,
  }

  const RETRY_HINT_MAX_MS = 1000
  const retryHint = (error) =>
    error.reason === 'frequency' &&
    Number.isSafeInteger(error.retryAfterMs) &&
    error.retryAfterMs >= 1 &&
    error.retryAfterMs <= RETRY_HINT_MAX_MS
      ? error.retryAfterMs
      : undefined

  async function withFrequencyRetry(operation) {
    try {
      return await operation()
    } catch (error) {
      const delay = retryHint(error)
      if (delay === undefined) throw error
      await new Promise((resolve) => window.setTimeout(resolve, delay))
      return operation()
    }
  }

  async function handle(invocation) {
    const handler = HANDLERS[invocation.action]
    try {
      if (!handler) throw new Error(`Unknown action ${invocation.action}`)
      if (!invocation.context?.workspace) throw new Error('This action needs a workspace')
      const value = await withFrequencyRetry(() =>
        handler(invocation.input, invocation.context, invocation.id),
      )
      bridge.send({ kind: 'action-result', id: invocation.id, value })
    } catch (error) {
      bridge.send({
        kind: 'action-result',
        id: invocation.id,
        error: String(error.message).slice(0, 500),
      })
    }
  }

  bridge.onMessage((message) => {
    if (message.kind === 'action') void handle(message.invocation)
  })
})()
