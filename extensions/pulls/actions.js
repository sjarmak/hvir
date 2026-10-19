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
  const SECTIONS = ['branch', 'needs', 'waiting', 'drafts']
  const STATUS_FIELDS = 'number,title,url,state,isDraft,author,headRefName,reviewDecision,reviewRequests,statusCheckRollup'
  /** Check runs report `conclusion`; legacy status contexts report `state`. */
  const checkResult = (check) => (check.conclusion || check.state || check.status || 'pending').toLowerCase()

  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

  /** Drop trailing rows until the result fits, and say how many went. */
  function fit(result, key) {
    const rows = [...result[key]]
    let omitted = 0
    while (rows.length && bytes({ ...result, [key]: rows, omitted }) > RESULT_BYTES) {
      rows.pop()
      omitted += 1
    }
    return { ...result, [key]: rows, omitted }
  }

  function compactRow(row, section, now) {
    const { pull, reason, since, waitingOn } = row
    return {
      number: pull.number,
      title: pull.title.slice(0, TITLE_CHARS),
      section,
      ...(reason ? { reason } : {}),
      ...(since === undefined ? {} : { waiting: age(since, now).label, since: new Date(since).toISOString() }),
      ...(pull.author ? { author: pull.author } : {}),
      ...(waitingOn.length ? { waitingOn: waitingOn.map(pullHandle) } : {}),
      url: pull.url,
    }
  }

  async function listPulls(input, context, actionId) {
    const section = input?.section
    if (section !== undefined && !SECTIONS.includes(section)) throw new Error(`section must be one of ${SECTIONS.join(', ')}`)
    const limit = input?.limit ?? 30
    const connectors = await window.host.availability({ actionId, workspace: context.workspace })
    if (connectors.gh !== 'supported')
      throw new Error(`gh is not approved for host ${context.workspace.host}${connectors.hosts.gh ? ` (approved for ${connectors.hosts.gh})` : ''}`)
    const useGit = connectors.git === 'supported'
    const snapshot = await window.pullsSource.snapshot(context.workspace, limit, useGit, actionId)
    const now = Date.now()
    const rows = pullSections(snapshot, now)
      .filter((entry) => section === undefined || entry.key === section)
      .flatMap((entry) => entry.rows.map((row) => compactRow(row, entry.key, now)))
    return fit({ repo: snapshot.repo, viewer: snapshot.viewer, hasMore: snapshot.hasMore, branchChecked: useGit, pulls: rows }, 'pulls')
  }

  function checkSummary(checks) {
    const counts = {}
    for (const check of checks) {
      const result = checkResult(check)
      counts[result] = (counts[result] ?? 0) + 1
    }
    const failing = checks
      .filter((check) => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(checkResult(check)))
      .map((check) => check.name || check.context)
      .slice(0, 10)
    return { counts, failing }
  }

  async function pullStatus(input, context, actionId) {
    const number = input?.number
    if (!Number.isInteger(number) || number < 1) throw new Error('number must be a positive integer')
    const repo = await window.pullsSource.repoFor(context.workspace, actionId)
    const pull = await window.host.run('gh', context.workspace, ['pr', 'view', String(number), '-R', repo, '--json', STATUS_FIELDS], { actionId })
    const requested = (pull.reviewRequests ?? []).map((entry) => entry.login || entry.name || entry.slug).filter(Boolean)
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

  const HANDLERS = { 'list-pulls': listPulls, 'pull-status': pullStatus }

  /** A view or updater read of the same command within a second answers `frequency`; wait it out once. */
  async function withFrequencyRetry(operation) {
    try {
      return await operation()
    } catch (error) {
      if (error.reason !== 'frequency') throw error
      await new Promise((resolve) => window.setTimeout(resolve, 1100))
      return operation()
    }
  }

  async function handle(invocation) {
    const handler = HANDLERS[invocation.action]
    try {
      if (!handler) throw new Error(`Unknown action ${invocation.action}`)
      if (!invocation.context?.workspace) throw new Error('This action needs a workspace')
      const value = await withFrequencyRetry(() => handler(invocation.input, invocation.context, invocation.id))
      bridge.send({ kind: 'action-result', id: invocation.id, value })
    } catch (error) {
      bridge.send({ kind: 'action-result', id: invocation.id, error: String(error.message).slice(0, 500) })
    }
  }

  bridge.onMessage((message) => {
    if (message.kind === 'action') void handle(message.invocation)
  })
})()
