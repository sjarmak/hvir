const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parsePulls } = require('../pull-parse.js')
const { pullsQueryArgs } = require('../pull-query.js')

const empty = { issueCount: 0, nodes: [] }
const assigned = (login, createdAt) => ({ __typename: 'AssignedEvent', createdAt, assignee: { login } })
const issueNode = (number, fields = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  state: 'OPEN',
  createdAt: '2026-10-12T13:00:00Z',
  updatedAt: '2026-10-14T13:00:00Z',
  author: { __typename: 'User', login: 'kai' },
  labels: { nodes: [{ name: 'bug' }, { name: 'ux' }] },
  assignees: { nodes: [{ login: 'steph' }] },
  comments: { totalCount: 2 },
  timelineItems: { nodes: [assigned('rin', '2026-10-12T14:00:00Z'), assigned('steph', '2026-10-13T09:00:00Z')] },
  ...fields,
})

const response = {
  data: {
    viewer: { login: 'steph' },
    mine: empty,
    review: empty,
    assigned: empty,
    issues: {
      issueCount: 4,
      nodes: [
        issueNode(301),
        issueNode(302, { assignees: { nodes: [] }, timelineItems: { nodes: [assigned('steph', '2026-10-01T09:00:00Z')] } }),
        { number: 303, url: 'https://github.com/acme/widgets/issues/303' },
      ],
    },
  },
}

test('issues assigned to the viewer parse with labels, comment count and the latest assignment', () => {
  const snapshot = parsePulls(response, { repo: 'acme/widgets', branch: undefined, localRepos: new Set() })
  assert.deepEqual(
    snapshot.issues.map((issue) => [issue.number, issue.labels, issue.comments, issue.viewerAssignedAt]),
    [
      [301, ['bug', 'ux'], 2, '2026-10-13T09:00:00Z'],
      [302, ['bug', 'ux'], 2, undefined],
    ],
  )
  assert.equal(snapshot.issues[0].author, 'kai')
  assert.equal(snapshot.hasMore, true)
})

test('a response without the issues search yields no issues and no extra paging', () => {
  const { issues: _issues, ...data } = response.data
  const snapshot = parsePulls({ data }, { repo: 'acme/widgets', branch: undefined, localRepos: new Set() })
  assert.deepEqual(snapshot.issues, [])
  assert.equal(snapshot.hasMore, false)
})

test('the list query searches open issues assigned to the viewer in the repository', () => {
  const args = pullsQueryArgs('acme/widgets', 'main', 30)
  assert.ok(args.includes('issues=repo:acme/widgets is:issue is:open assignee:@me sort:updated-desc'))
  assert.match(args[3], /issues: search\(query: \$issues, type: ISSUE, first: \$limit\) \{ issueCount nodes \{ \.\.\.issue \} \}/)
  assert.match(args[3], /fragment issue on Issue/)
})

const user = (login) => ({ __typename: 'User', login })
const pullNode = (number, fields = {}) => ({
  number,
  title: `Pull ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat-b',
  baseRefName: 'feat-a',
  createdAt: '2026-10-10T13:00:00Z',
  updatedAt: '2026-10-14T13:00:00Z',
  author: user('steph'),
  commits: { nodes: [{ commit: { oid: 'abc', committedDate: '2026-10-12T13:00:00Z' } }] },
  ...fields,
})
const withPulls = (nodes) => ({
  data: { ...response.data, mine: { issueCount: nodes.length, nodes }, issues: empty },
})
const parseOne = (node) =>
  parsePulls(withPulls([node]), { repo: 'acme/widgets', branch: undefined, localRepos: new Set() }).authored[0]

test('a pull carries its base branch and the latest review or comment by someone else', () => {
  const parsed = parseOne(
    pullNode(71, {
      reviews: {
        nodes: [
          { state: 'APPROVED', body: '', submittedAt: '2026-10-13T13:00:00Z', author: user('rin') },
          { state: 'COMMENTED', body: 'ok', submittedAt: '2026-10-14T09:00:00Z', author: { __typename: 'Bot', login: 'ci' } },
        ],
      },
      comments: {
        nodes: [
          { createdAt: '2026-10-11T13:00:00Z', author: user('kai') },
          { createdAt: '2026-10-14T10:00:00Z', author: user('steph') },
        ],
      },
    }),
  )
  assert.equal(parsed.baseRef, 'feat-a')
  assert.deepEqual(parsed.activity, { kind: 'approved', by: 'rin', at: '2026-10-13T13:00:00Z' })
  assert.equal(parsed.reviewedByOthers, true)
  assert.equal(parsed.newSinceViewer, 0)
})

test('reviews and comments after the author last pushed count as new', () => {
  const parsed = parseOne(
    pullNode(72, {
      reviews: { nodes: [{ state: 'CHANGES_REQUESTED', body: 'fix', submittedAt: '2026-10-13T13:00:00Z', author: user('rin') }] },
      comments: { nodes: [{ createdAt: '2026-10-11T13:00:00Z', author: user('kai') }, { createdAt: '2026-10-14T13:00:00Z', author: user('kai') }] },
    }),
  )
  assert.deepEqual(parsed.activity, { kind: 'commented', by: 'kai', at: '2026-10-14T13:00:00Z' })
  assert.equal(parsed.newSinceViewer, 2)
})

test('a pull with no human activity has no activity and is not reviewed', () => {
  const parsed = parseOne(pullNode(73, { comments: { nodes: [{ createdAt: '2026-10-14T13:00:00Z', author: { __typename: 'Bot', login: 'ci' } }] } }))
  assert.equal(parsed.activity, undefined)
  assert.equal(parsed.reviewedByOthers, false)
})

test('the list query reads each pull request base branch', () => {
  assert.match(pullsQueryArgs('acme/widgets', 'main', 30)[3], /headRefName baseRefName/)
})

test('every search returns the most recently updated results first so the page holds the latest activity', () => {
  const args = pullsQueryArgs('acme/widgets', 'main', 30)
  for (const [name, qualifier] of [
    ['mine', 'author:@me'],
    ['review', 'review-requested:@me'],
    ['assigned', 'assignee:@me'],
  ])
    assert.ok(args.includes(`${name}=repo:acme/widgets is:pr is:open ${qualifier} sort:updated-desc`))
})
