/* global window, module */
;(() => {
  const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
  const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
  const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

  const target = (input) => {
    const repo = input?.repo
    const number = input?.number
    if (typeof repo !== 'string' || !REPO.test(repo) || !Number.isSafeInteger(number) || number < 1) return null
    return { repo, number }
  }

  const prArgs = ({ repo, number }) => ['--repo', repo, '--number', String(number), '--json']

  const checkState = (check) => {
    const result = check?.conclusion || check?.state || ''
    if (check?.status && check.status !== 'COMPLETED') return 'pending'
    if (result === 'SUCCESS') return 'passed'
    if (FAILED.has(result)) return 'failed'
    if (SKIPPED.has(result)) return 'skipped'
    return 'pending'
  }

  const checks = (rollup) => {
    const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 }
    const failing = []
    for (const check of Array.isArray(rollup) ? rollup : []) {
      const state = checkState(check)
      counts[state] += 1
      if (state === 'failed') failing.push(check.name || check.context || 'unnamed check')
    }
    return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0), failing }
  }

  const checksLine = (summary) => summary.total === 0 ? 'No checks'
    : ['passed', 'failed', 'pending', 'skipped'].filter((key) => summary[key] > 0)
      .map((key) => `${summary[key]} ${key}`).join(' · ')

  const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }

  const metaLine = (pull, repo) => [
    `${repo}#${pull.number}`,
    pull.isDraft ? 'draft' : String(pull.state ?? '').toLowerCase(),
    pull.author?.login,
    REVIEW[pull.reviewDecision] ?? '',
    `${pull.headRefName ?? '?'} → ${pull.baseRefName ?? '?'}`,
    `+${pull.additions ?? 0} −${pull.deletions ?? 0} in ${pull.changedFiles ?? 0} files`,
  ].filter(Boolean).join(' · ')

  const recordLine = (record, headOid) => {
    if (!record) return 'No city review record for this PR.'
    const head = typeof record['pr.head_sha'] === 'string' ? record['pr.head_sha'] : ''
    const at = head === '' ? 'head unknown'
      : head === headOid ? `at the current head ${head.slice(0, 12)}`
        : `at ${head.slice(0, 12)}, an older head (the PR moved since)`
    const verdict = record['pr.review_verdict'] ?? 'no verdict'
    const blocking = record['pr.review_blocking']
    return [`City review${record['pr.review_round'] ? ` round ${record['pr.review_round']}` : ''}: ${verdict}`,
      blocking === undefined || blocking === null ? '' : `${blocking} blocking`,
      record['pr.review_counts'] ?? '', at, record.id].filter((part) => part !== '').join(' · ')
  }

  const api = Object.freeze({ target, prArgs, checks, checksLine, metaLine, recordLine })
  if (typeof module === 'object') module.exports = api
  else window.pullModel = api
})()
