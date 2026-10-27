/* global window, module */
/**
 * GraphQL pull nodes to the panel's pull summaries, ported from src/main/github/github-parse.ts,
 * github-reviewers.ts and pr-feedback.ts. Bots are dropped by GraphQL type, never by login.
 */
;(() => {
  const CHECKS = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' }
  const REVIEWS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'review-required' }
  const STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
  const REVIEWER_STATES = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested' }
  const ACTIONABLE_REVIEW_STATES = new Set(['COMMENTED', 'CHANGES_REQUESTED'])
  const ACTIVITY_KINDS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' }
  const TEAM_TYPES = new Set(['Team', 'EnterpriseTeam'])

  const nodesOf = (connection) => (Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : [])
  const str = (value) => (typeof value === 'string' ? value : undefined)
  const actor = (value) => ({ login: str(value?.login), bot: value?.__typename === 'Bot' })

  /** The later of two ISO timestamps; an unparseable candidate never replaces a held one. */
  function laterIso(current, candidate) {
    if (current === undefined) return candidate
    const next = Date.parse(candidate)
    if (Number.isNaN(next)) return current
    const held = Date.parse(current)
    return Number.isNaN(held) || next > held ? candidate : current
  }

  /** Users and teams can act on a request; bots and mannequins cannot, so they are absent. */
  function requestedReviewer(value) {
    if (value?.__typename === 'User' && str(value.login)) return { login: value.login, kind: 'user' }
    if (TEAM_TYPES.has(value?.__typename) && str(value.combinedSlug)) return { login: value.combinedSlug, kind: 'team' }
    return undefined
  }

  function applyEvent(timeline, event, viewer) {
    const at = str(event.createdAt)
    if (at === undefined) return timeline
    if (event.__typename === 'ReviewRequestedEvent') {
      const reviewer = requestedReviewer(event.requestedReviewer)
      if (!reviewer) return timeline
      const requestedAt = { ...timeline.requestedAt, [reviewer.login]: laterIso(timeline.requestedAt[reviewer.login], at) }
      return { ...timeline, requestedAt }
    }
    if (event.__typename === 'ReadyForReviewEvent')
      return { ...timeline, readyForReviewAt: laterIso(timeline.readyForReviewAt, at) }
    if (event.__typename === 'AssignedEvent' && event.assignee?.login === viewer)
      return { ...timeline, viewerAssignedAt: laterIso(timeline.viewerAssignedAt, at) }
    return timeline
  }

  function timelineOf(node, viewer) {
    const timeline = nodesOf(node.timelineItems).reduce((current, event) => applyEvent(current, event, viewer), {
      requestedAt: {},
    })
    if (nodesOf(node.assignees).some((user) => user.login === viewer)) return timeline
    const { viewerAssignedAt: _unassigned, ...rest } = timeline
    return rest
  }

  function opinionatedReviews(node) {
    return nodesOf(node.latestOpinionatedReviews).flatMap((review) => {
      const { login, bot } = actor(review.author)
      const reviewState = REVIEWER_STATES[review.state]
      if (bot || !login || !reviewState) return []
      return [{ login, reviewState, reviewedAt: str(review.submittedAt) }]
    })
  }

  function reviewersOf(node, requestedAt) {
    const pending = nodesOf(node.reviewRequests).flatMap((request) => requestedReviewer(request.requestedReviewer) ?? [])
    const reviewed = opinionatedReviews(node)
    const byLogin = new Map(reviewed.map((review) => [review.login, review]))
    const pendingLogins = new Set(pending.map((reviewer) => reviewer.login))
    return [
      ...pending.map((reviewer) => ({
        ...reviewer,
        pending: true,
        requestedAt: requestedAt[reviewer.login],
        ...byLogin.get(reviewer.login),
      })),
      ...reviewed
        .filter((review) => !pendingLogins.has(review.login))
        .map((review) => ({ kind: 'user', pending: false, requestedAt: requestedAt[review.login], ...review })),
    ]
  }

  const supersededByPush = (at, head) => at !== undefined && head !== undefined && Date.parse(at) <= Date.parse(head)

  /** Unresolved current threads, plus reviews with a body and non-bot comments from others written after the last push. */
  function openFeedback(node, viewer, headCommittedAt) {
    const threads = nodesOf(node.reviewThreads).filter((thread) => !thread.isResolved && !thread.isOutdated)
    const reviews = nodesOf(node.reviews).filter(
      (review) =>
        ACTIONABLE_REVIEW_STATES.has(review.state) &&
        (review.body ?? '').trim() !== '' &&
        review.author?.login !== viewer &&
        !supersededByPush(review.submittedAt, headCommittedAt),
    )
    const comments = nodesOf(node.comments).filter((comment) => {
      const { login, bot } = actor(comment.author)
      return !bot && login !== viewer && !supersededByPush(comment.createdAt, headCommittedAt)
    })
    return threads.length + reviews.length + comments.length
  }

  function viewerReviewedAt(node, viewer) {
    return nodesOf(node.reviews)
      .filter((review) => !actor(review.author).bot && review.author?.login === viewer && str(review.submittedAt))
      .reduce((latest, review) => laterIso(latest, review.submittedAt), undefined)
  }

  const isoMs = (value) => {
    const ms = Date.parse(value ?? '')
    return Number.isNaN(ms) ? undefined : ms
  }

  function humanEvents(node) {
    const reviews = nodesOf(node.reviews).flatMap((review) => {
      const { login, bot } = actor(review.author)
      const kind = ACTIVITY_KINDS[review.state]
      const at = str(review.submittedAt)
      return bot || !login || !kind || isoMs(at) === undefined ? [] : [{ kind, by: login, at, review: true }]
    })
    const comments = nodesOf(node.comments).flatMap((comment) => {
      const { login, bot } = actor(comment.author)
      const at = str(comment.createdAt)
      return bot || !login || isoMs(at) === undefined ? [] : [{ kind: 'commented', by: login, at }]
    })
    return [...reviews, ...comments]
  }

  function activityOf(node, viewer, author, headCommittedAt) {
    const events = humanEvents(node)
    const others = events.filter((event) => event.by !== viewer)
    const latest = others.reduce(
      (best, event) => (best === undefined || isoMs(event.at) > isoMs(best.at) ? event : best),
      undefined,
    )
    const viewerTimes = [
      ...events.filter((event) => event.by === viewer).map((event) => isoMs(event.at)),
      ...(author === viewer ? [isoMs(headCommittedAt), isoMs(node.createdAt)] : []),
    ].filter((ms) => ms !== undefined)
    const reviewedByOthers = others.some((event) => event.review)
    const activity = latest && { kind: latest.kind, by: latest.by, at: latest.at }
    if (viewerTimes.length === 0) return { activity, reviewedByOthers }
    const actedAt = Math.max(...viewerTimes)
    const newSinceViewer = others.filter((event) => isoMs(event.at) > actedAt).length
    return { activity, reviewedByOthers, newSinceViewer }
  }

  function parsePull(node, viewer) {
    if (typeof node.number !== 'number' || !str(node.title) || !str(node.url)) return undefined
    const head = nodesOf(node.commits)[0]?.commit
    const headCommittedAt = str(head?.committedDate)
    const author = actor(node.author).login ?? ''
    const { requestedAt, ...timeline } = timelineOf(node, viewer)
    return {
      number: node.number,
      title: node.title,
      url: node.url,
      state: STATES[node.state] ?? 'open',
      draft: node.isDraft === true,
      headRef: str(node.headRefName) ?? '',
      baseRef: str(node.baseRefName) ?? '',
      headRepo: str(node.headRepository?.nameWithOwner)?.toLowerCase(),
      author,
      createdAt: str(node.createdAt) ?? '',
      updatedAt: str(node.updatedAt) ?? '',
      checks: CHECKS[head?.statusCheckRollup?.state] ?? 'none',
      review: REVIEWS[node.reviewDecision] ?? 'none',
      openFeedback: author === viewer ? openFeedback(node, viewer, headCommittedAt) : 0,
      headOid: str(head?.oid),
      headCommittedAt,
      ...timeline,
      viewerReviewedAt: viewerReviewedAt(node, viewer),
      additions: node.additions,
      deletions: node.deletions,
      changedFiles: node.changedFiles,
      reviewers: reviewersOf(node, requestedAt),
      ...activityOf(node, viewer, author, headCommittedAt),
    }
  }

  function parseIssue(node, viewer) {
    if (typeof node.number !== 'number' || !str(node.title) || !str(node.url)) return undefined
    const { viewerAssignedAt } = timelineOf(node, viewer)
    return {
      number: node.number,
      title: node.title,
      url: node.url,
      state: STATES[node.state] ?? 'open',
      author: actor(node.author).login ?? '',
      createdAt: str(node.createdAt) ?? '',
      updatedAt: str(node.updatedAt) ?? '',
      labels: nodesOf(node.labels).flatMap((label) => str(label.name) ?? []),
      comments: typeof node.comments?.totalCount === 'number' ? node.comments.totalCount : 0,
      viewerAssignedAt,
    }
  }

  const pullsOf = (connection, viewer) => nodesOf(connection).flatMap((node) => parsePull(node, viewer) ?? [])
  const issuesOf = (connection, viewer) => nodesOf(connection).flatMap((node) => parseIssue(node, viewer) ?? [])
  const searchHasMore = (connection) =>
    typeof connection?.issueCount === 'number' && connection.issueCount > nodesOf(connection).length

  /**
   * One snapshot from the panel query. Branch pull requests count only when their head lives in a
   * repository this checkout has as a remote, and never on the default branch.
   */
  function parsePulls(response, { repo, branch, localRepos }) {
    if (Array.isArray(response?.errors) && response.errors.length > 0)
      throw new Error(`GitHub GraphQL error: ${response.errors.map((error) => error?.message ?? 'unknown').join('; ')}`)
    const data = response?.data
    if (!data) throw new Error('GitHub GraphQL response carried no data')
    const viewer = str(data.viewer?.login) ?? ''
    const onDefault = branch !== undefined && branch === data.repository?.defaultBranchRef?.name
    const branchPulls = onDefault
      ? []
      : pullsOf(data.repository?.branch, viewer).filter((pull) => localRepos.has(pull.headRepo))
    const reviewRequested = [...pullsOf(data.review, viewer), ...pullsOf(data.assigned, viewer)]
    return {
      repo,
      branch,
      viewer,
      branchPulls,
      authored: [...pullsOf(data.mine, viewer), ...pullsOf(data.drafts, viewer)],
      reviewRequested: reviewRequested.filter(
        (pull, index) => reviewRequested.findIndex((other) => other.number === pull.number) === index,
      ),
      issues: issuesOf(data.issues, viewer),
      hasMore: [data.mine, data.drafts, data.review, data.assigned, data.issues].some(searchHasMore),
    }
  }

  const GITHUB_REMOTE =
    /(?:^|\s)(?:(?:https?|ssh):\/\/(?:[^@/\s]+@)?github\.com[/:]|[^@/\s]+@github\.com:)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?=\s|$)/gm

  /** `owner/name` (lowercased) of every GitHub remote in `git remote -v` output. */
  const githubRemoteRepos = (output) =>
    new Set([...output.matchAll(GITHUB_REMOTE)].map(([, owner, name]) => `${owner}/${name}`.toLowerCase()))

  const api = Object.freeze({ parsePulls, githubRemoteRepos })
  if (typeof module === 'object') module.exports = api
  else window.pullParse = api
})()
