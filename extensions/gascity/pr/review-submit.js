/* global window, module */
;(() => {
  const START = `mutation($pull: ID!, $commit: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pull, commitOID: $commit }) {
    pullRequestReview { id }
  }
}`
  const THREAD = `mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $review, path: $path, line: $line, side: $side, body: $body
  }) { thread { id } }
}`
  const SUBMIT = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) {
    pullRequestReview { url state }
  }
}`

  const graphql = (query, fields, typed = []) => [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
    ...typed.flatMap(([key, value]) => ['-F', `${key}=${value}`]),
  ]

  function validate({ event, summary, drafts, isAuthor, pendingComments = 0 }) {
    if (isAuthor && event !== 'COMMENT')
      return 'You can only comment on your own pull request.'
    if (event === 'REQUEST_CHANGES' && summary.trim() === '')
      return 'Requesting changes needs a summary.'
    if (
      event === 'COMMENT' &&
      summary.trim() === '' &&
      drafts.length + pendingComments === 0
    )
      return 'A comment review needs a summary or at least one line comment.'
    if (drafts.some((draft) => draft.body.trim() === ''))
      return 'One of the line comments is empty.'
    return undefined
  }

  const startArgs = (pullId, commit) => graphql(START, { pull: pullId, commit })
  const threadArgs = (reviewId, draft) =>
    graphql(
      THREAD,
      { review: reviewId, path: draft.path, side: draft.side, body: draft.body },
      [['line', draft.line]],
    )
  const submitArgs = (reviewId, event, summary) =>
    graphql(SUBMIT, {
      review: reviewId,
      event,
      ...(summary.trim() ? { body: summary } : {}),
    })

  function graphqlError(response) {
    const [first] = response?.errors ?? []
    return first ? new Error(first.message) : undefined
  }

  async function submitReview({
    run,
    pull,
    pendingReviewId,
    drafts,
    event,
    summary,
    onStarted = () => {},
    onPosted = () => {},
  }) {
    const call = async (args) => {
      const response = await run(args)
      const error = graphqlError(response)
      if (error) throw error
      return response.data
    }
    const reviewId =
      pendingReviewId ??
      (await call(startArgs(pull.id, pull.headRefOid))).addPullRequestReview
        .pullRequestReview.id
    onStarted(reviewId)
    for (const draft of drafts) {
      await call(threadArgs(reviewId, draft))
      await onPosted(draft)
    }
    const submitted = await call(submitArgs(reviewId, event, summary))
    return submitted.submitPullRequestReview.pullRequestReview
  }

  const api = Object.freeze({
    validate,
    submitReview,
  })
  if (typeof module === 'object') module.exports = api
  else window.reviewSubmit = api
})()
