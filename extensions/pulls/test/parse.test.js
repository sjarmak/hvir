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
  assert.ok(args.includes('issues=repo:acme/widgets is:issue is:open assignee:@me'))
  assert.match(args[3], /issues: search\(query: \$issues, type: ISSUE, first: \$limit\) \{ issueCount nodes \{ \.\.\.issue \} \}/)
  assert.match(args[3], /fragment issue on Issue/)
})
