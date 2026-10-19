/* global window, module, require */
/**
 * The panel's sections (src/renderer/src/github/pulls-model.ts): This branch keeps its membership
 * and recency order; Needs you, Waiting and Drafts come from the shared wait derivation, minus
 * the pull requests the branch already shows.
 */
;(() => {
  const node = typeof module === 'object'
  const { pullWaitRows } = node ? require('./pull-waits.js') : window.pullWaits
  const { businessMsBetween, formatBusinessAge, businessAgeTone } = node
    ? require('./business-time.js')
    : window.businessTime

  const SECTIONS = [
    ['branch', 'This branch'],
    ['needs', 'Needs you'],
    ['waiting', 'Waiting'],
    ['drafts', 'Drafts'],
  ]
  const CHECK_LABELS = { passing: 'CI passing', failing: 'CI failing', pending: 'CI running', none: '' }
  const REVIEW_LABELS = {
    approved: 'Approved',
    'changes-requested': 'Changes requested',
    'review-required': 'Review required',
    none: '',
  }

  /** Whose pull request a row is; `other` (someone else's branch, no ask) shows the author instead. */
  const ROLE_LABELS = { author: 'Yours', reviewer: 'Reviewer', other: '' }
  const roleLabel = (row) => ROLE_LABELS[row.role]

  const byOpenThenNewest = (left, right) =>
    Number(right.state === 'open') - Number(left.state === 'open') || right.updatedAt.localeCompare(left.updatedAt)

  function pullSections(snapshot, now) {
    const waits = pullWaitRows(snapshot, now)
    const branch = snapshot.branchPulls
      .filter((pull, index, all) => all.findIndex((other) => other.number === pull.number) === index)
      .sort(byOpenThenNewest)
    const shown = new Set(branch.map((pull) => pull.number))
    const branchRows = branch.map(
      (pull) =>
        waits.find((wait) => wait.pull.number === pull.number) ?? {
          pull,
          reason: '',
          waitingOn: [],
          role: pull.author === snapshot.viewer ? 'author' : 'other',
        },
    )
    return SECTIONS.map(([key, label]) => ({
      key,
      label,
      rows:
        key === 'branch' ? branchRows : waits.filter((wait) => wait.list === key && !shown.has(wait.pull.number)),
    }))
  }

  /**
   * The header count: distinct pull requests (by URL) that need the viewer across snapshots. A
   * branch pull request that needs the viewer counts even though the panel lists it under This branch.
   */
  function needYouCount(snapshots, now) {
    const urls = new Set(
      snapshots.flatMap((snapshot) =>
        pullWaitRows(snapshot, now).flatMap((row) => (row.list === 'needs' ? [row.pull.url] : [])),
      ),
    )
    return urls.size
  }

  function age(since, now) {
    const ms = businessMsBetween(since, now)
    return { label: formatBusinessAge(ms), tone: businessAgeTone(ms) }
  }

  /** Status badges for a row; one that only restates the reason chip is left out. */
  function badges({ pull, reason }) {
    const labels = [
      pull.state !== 'open' ? pull.state : '',
      pull.draft ? 'draft' : '',
      CHECK_LABELS[pull.checks],
      REVIEW_LABELS[pull.review],
      pull.openFeedback > 0 ? `${pull.openFeedback} open ${pull.openFeedback === 1 ? 'comment' : 'comments'}` : '',
    ]
    return labels.filter((label) => label !== '' && label.toLowerCase() !== reason.toLowerCase())
  }

  const api = Object.freeze({ pullSections, needYouCount, age, badges, roleLabel })
  if (node) module.exports = api
  else window.pullsModel = api
})()
