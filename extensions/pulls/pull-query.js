/* global window, module */
/** GraphQL the PR panel sends (src/main/github/github-query.ts), as gh api graphql arguments. */
;(() => {
  const PULL_FIELDS = `
fragment pull on PullRequest {
  number title url state isDraft headRefName createdAt updatedAt reviewDecision
  additions deletions changedFiles
  headRepository { nameWithOwner }
  author { login }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
  reviewThreads(last: 100) { nodes { isResolved isOutdated } }
  reviews(last: 50) { nodes { state body submittedAt author { __typename login } } }
  comments(last: 50) { nodes { createdAt author { __typename login } } }
  reviewRequests(first: 50) {
    nodes { requestedReviewer { ...reviewer } }
  }
  latestOpinionatedReviews(last: 30) {
    nodes { state submittedAt author { __typename login } }
  }
  timelineItems(
    itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, ASSIGNED_EVENT], last: 50
  ) {
    nodes {
      __typename
      ... on ReviewRequestedEvent { createdAt requestedReviewer { ...reviewer } }
      ... on ReadyForReviewEvent { createdAt }
      ... on AssignedEvent { createdAt assignee { ... on User { login } } }
    }
  }
  assignees(first: 20) { nodes { login } }
}
fragment reviewer on RequestedReviewer {
  __typename
  ... on User { login }
  ... on Team { combinedSlug }
  ... on EnterpriseTeam { combinedSlug }
}
fragment issue on Issue {
  number title url state createdAt updatedAt
  author { __typename login }
  labels(first: 10) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  comments { totalCount }
  timelineItems(itemTypes: [ASSIGNED_EVENT], last: 50) {
    nodes { __typename ... on AssignedEvent { createdAt assignee { ... on User { login } } } }
  }
}`

  const PULLS_QUERY = `query(
  $owner: String!, $name: String!, $branch: String!, $hasBranch: Boolean!,
  $mine: String!, $review: String!, $assigned: String!, $issues: String!, $limit: Int!
) {
  viewer { login }
  repository(owner: $owner, name: $name) @include(if: $hasBranch) {
    defaultBranchRef { name }
    branch: pullRequests(
      headRefName: $branch, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }
    ) { nodes { ...pull } }
  }
  mine: search(query: $mine, type: ISSUE, first: $limit) { issueCount nodes { ...pull } }
  review: search(query: $review, type: ISSUE, first: $limit) { issueCount nodes { ...pull } }
  assigned: search(query: $assigned, type: ISSUE, first: $limit) { issueCount nodes { ...pull } }
  issues: search(query: $issues, type: ISSUE, first: $limit) { issueCount nodes { ...issue } }
}
${PULL_FIELDS}`

  const PULL_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url headRefOid
      reviewThreads(first: 40) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line
          comments(first: 20) {
            pageInfo { hasNextPage }
            nodes { id body createdAt commit { oid } author { login } }
          }
        }
      }
    }
  }
}`

  function pullsQueryArgs(repo, branch, limit) {
    const [owner, name] = repo.split('/')
    const search = (qualifier) => `repo:${repo} is:pr is:open ${qualifier}`
    return [
      'api', 'graphql',
      '-f', `query=${PULLS_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-f', `branch=${branch ?? ''}`,
      '-F', `hasBranch=${branch === undefined ? 'false' : 'true'}`,
      '-f', `mine=${search('author:@me')}`,
      '-f', `review=${search('review-requested:@me')}`,
      '-f', `assigned=${search('assignee:@me')}`,
      '-f', `issues=repo:${repo} is:issue is:open assignee:@me`,
      '-F', `limit=${limit}`,
    ]
  }

  function pullDetailQueryArgs(repo, number) {
    const [owner, name] = repo.split('/')
    return [
      'api', 'graphql',
      '-f', `query=${PULL_DETAIL_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
    ]
  }

  const api = Object.freeze({ pullsQueryArgs, pullDetailQueryArgs })
  if (typeof module === 'object') module.exports = api
  else window.pullQuery = api
})()
