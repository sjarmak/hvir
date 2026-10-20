process.env.TZ = 'America/New_York'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { businessMsBetween, formatBusinessAge, businessAgeTone, BUSINESS_DAY_MS } = require('../business-time.js')
const { pullWaitRows } = require('../pull-waits.js')
const { pullSections, issueRows, needYouCount, age, badges, roleLabel } = require('../pulls-model.js')

const at = (iso) => new Date(iso).getTime()
const HOUR = 3_600_000

test('business time skips the weekend between a Friday ask and a Monday read', () => {
  const ms = businessMsBetween(at('2026-10-16T17:00:00'), at('2026-10-19T10:00:00'))
  assert.equal(ms, 17 * HOUR)
  assert.equal(formatBusinessAge(ms), '17h')
  assert.equal(businessAgeTone(ms), 'neutral')
})

test('Thursday morning to Tuesday afternoon is three business days and red', () => {
  const ms = businessMsBetween(at('2026-10-15T09:00:00'), at('2026-10-20T15:00:00'))
  assert.equal(ms, 78 * HOUR)
  assert.equal(formatBusinessAge(ms), '3d')
  assert.equal(businessAgeTone(ms), 'red')
})

test('a span inside one weekend and a reversed span are both zero', () => {
  assert.equal(businessMsBetween(at('2026-10-17T10:00:00'), at('2026-10-18T20:00:00')), 0)
  assert.equal(businessMsBetween(at('2026-10-20T10:00:00'), at('2026-10-19T10:00:00')), 0)
})

test('age labels and tones switch at the named thresholds', () => {
  assert.equal(formatBusinessAge(59 * 60_000 + 59_000), '59m')
  assert.equal(formatBusinessAge(HOUR * 5 + 1), '5h')
  assert.equal(businessAgeTone(BUSINESS_DAY_MS - 1), 'neutral')
  assert.equal(businessAgeTone(BUSINESS_DAY_MS), 'amber')
  assert.equal(businessAgeTone(3 * BUSINESS_DAY_MS - 1), 'amber')
})

const pull = (number, fields = {}) => ({
  number,
  title: `Pull ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  state: 'open',
  draft: false,
  headRef: `branch-${number}`,
  author: 'steph',
  createdAt: '2026-10-05T09:00:00-04:00',
  updatedAt: '2026-10-14T09:00:00-04:00',
  checks: 'passing',
  review: 'none',
  openFeedback: 0,
  reviewers: [],
  ...fields,
})
const issue = (number, fields = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  state: 'open',
  author: 'kai',
  createdAt: '2026-10-12T09:00:00-04:00',
  updatedAt: '2026-10-14T09:00:00-04:00',
  labels: [],
  comments: 0,
  ...fields,
})
const NOW = at('2026-10-20T15:00:00')

const snapshot = {
  repo: 'acme/widgets',
  viewer: 'steph',
  branch: 'branch-71',
  branchPulls: [],
  authored: [
    pull(71, { reviewers: [{ login: 'kai', kind: 'user', pending: true, requestedAt: '2026-10-13T11:00:00-04:00' }] }),
    pull(72, {
      review: 'changes-requested',
      reviewers: [
        { login: 'rin', kind: 'user', pending: false, reviewState: 'changes-requested', reviewedAt: '2026-10-09T16:00:00-04:00' },
      ],
    }),
    pull(73, { checks: 'failing', headCommittedAt: '2026-10-19T08:30:00-04:00' }),
    pull(74, { draft: true, updatedAt: '2026-10-12T09:00:00-04:00' }),
    pull(75, { draft: true, updatedAt: '2026-10-19T09:00:00-04:00' }),
    pull(76, { state: 'merged' }),
  ],
  reviewRequested: [
    pull(80, {
      author: 'kai',
      readyForReviewAt: '2026-10-14T13:00:00-04:00',
      reviewers: [{ login: 'steph', kind: 'user', pending: true, requestedAt: '2026-10-08T10:00:00-04:00' }],
    }),
    pull(81, {
      author: 'rin',
      viewerReviewedAt: '2026-10-16T12:00:00-04:00',
      reviewers: [{ login: 'acme/core', kind: 'team', pending: true, requestedAt: '2026-10-15T12:00:00-04:00' }],
    }),
    pull(82, { author: 'rin', viewerAssignedAt: '2026-10-06T10:00:00-04:00' }),
  ],
  issues: [
    issue(301, { viewerAssignedAt: '2026-10-15T10:00:00-04:00' }),
    issue(302, { viewerAssignedAt: '2026-10-07T10:00:00-04:00', labels: ['bug'], comments: 3 }),
    issue(303, { state: 'closed', viewerAssignedAt: '2026-10-01T10:00:00-04:00' }),
    issue(304),
    issue(302, { viewerAssignedAt: '2026-10-07T10:00:00-04:00' }),
  ],
}

test('rows rank needs then waiting oldest ask first, drafts newest first', () => {
  const rows = pullWaitRows(snapshot, NOW)
  assert.deepEqual(
    rows.map((row) => [row.pull.number, row.list, row.reason]),
    [
      [82, 'needs', 'Assigned'],
      [72, 'needs', 'Changes requested'],
      [80, 'needs', 'Requested'],
      [73, 'needs', 'CI failing'],
      [71, 'waiting', 'Waiting'],
      [75, 'drafts', 'Draft'],
      [74, 'drafts', 'Draft'],
    ],
  )
})

test('a request counts from the later of the ask and ready for review; a team ask already answered drops out', () => {
  const rows = pullWaitRows(snapshot, NOW)
  const ready = rows.find((row) => row.pull.number === 80)
  assert.equal(ready.since, at('2026-10-14T13:00:00-04:00'))
  assert.equal(age(ready.since, NOW).label, '4d')
  assert.equal(rows.some((row) => row.pull.number === 81), false)
  assert.deepEqual(rows.find((row) => row.pull.number === 71).waitingOn, ['kai'])
})

test('This branch keeps its pull request out of the wait sections and badges skip the reason', () => {
  const sections = pullSections({ ...snapshot, branchPulls: [snapshot.authored[0]] }, NOW)
  assert.deepEqual(
    sections.map((section) => [section.key, section.rows.map((row) => (row.pull ?? row.issue).number)]),
    [
      ['branch', [71]],
      ['needs', [82, 72, 80, 73]],
      ['issues', [302, 304, 301]],
      ['waiting', []],
      ['drafts', [75, 74]],
    ],
  )
  const failing = sections[1].rows.find((row) => row.pull.number === 73)
  assert.deepEqual(badges(failing), [])
  assert.deepEqual(badges({ ...failing, reason: 'Assigned' }), ['CI failing'])
})

test('the header count includes a branch pull request that needs the viewer and dedupes by URL', () => {
  const onBranch = { ...snapshot, branchPulls: [snapshot.authored[1]] }
  const needsSection = pullSections(onBranch, NOW).find((section) => section.key === 'needs')
  assert.equal(needsSection.rows.some((row) => row.pull.number === 72), false)
  assert.equal(needYouCount([onBranch], NOW), 4)
  const other = {
    ...snapshot,
    repo: 'acme/gadgets',
    authored: [pull(90, { url: 'https://github.com/acme/gadgets/pull/90', checks: 'failing' })],
    reviewRequested: [],
  }
  assert.equal(needYouCount([onBranch, snapshot, other], NOW), 5)
  assert.equal(needYouCount([], NOW), 0)
})

test('rows say whose pull request it is: yours, an ask of you, or someone else on this branch', () => {
  const rows = pullWaitRows(snapshot, NOW)
  const roleOf = (number) => rows.find((row) => row.pull.number === number)?.role
  assert.equal(roleOf(72), 'author')
  assert.equal(roleOf(80), 'reviewer')
  const theirs = pull(90, { author: 'kai' })
  const [branch] = pullSections({ ...snapshot, branchPulls: [theirs, snapshot.authored[1]] }, NOW)
  assert.deepEqual(
    branch.rows.map((row) => [row.pull.number, row.role, roleLabel(row)]),
    [
      [90, 'other', ''],
      [72, 'author', 'Yours'],
    ],
  )
  assert.equal(roleLabel(rows.find((row) => row.pull.number === 80)), 'Reviewer')
})

test('assigned issues list open ones once, oldest assignment first, falling back to creation', () => {
  const rows = issueRows(snapshot, NOW)
  assert.deepEqual(
    rows.map((row) => [row.issue.number, row.role, roleLabel(row)]),
    [
      [302, 'assignee', 'Assigned'],
      [304, 'assignee', 'Assigned'],
      [301, 'assignee', 'Assigned'],
    ],
  )
  assert.equal(rows[0].since, at('2026-10-07T10:00:00-04:00'))
  assert.equal(rows[1].since, at('2026-10-12T09:00:00-04:00'))
  assert.equal(age(rows[0].since, NOW).label, '9d')
  assert.deepEqual(issueRows({ ...snapshot, issues: undefined }, NOW), [])
})

test('assigned issues never change the header count', () => {
  assert.equal(needYouCount([snapshot], NOW), needYouCount([{ ...snapshot, issues: [] }], NOW))
})
