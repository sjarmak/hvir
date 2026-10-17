import { describe, expect, it } from 'vitest'

import { deriveHolders, laterOf, pullHandle, pullWaitRows } from '../src/shared'
import type { PullReviewer, PullSummary, PullsSnapshot } from '../src/shared'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const CREATED = '2026-10-01T00:00:00Z'
const READY = '2026-10-05T00:00:00Z'
const REQUESTED = '2026-10-07T00:00:00Z'
const REVIEWED = '2026-10-09T00:00:00Z'
const at = (iso: string): number => Date.parse(iso)

function pull(number: number, overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'open',
    draft: false,
    headRef: `branch-${number}`,
    author: 'stephanie',
    createdAt: CREATED,
    updatedAt: '2026-10-10T00:00:00Z',
    checks: 'passing',
    review: 'none',
    openFeedback: 0,
    reviewers: [],
    ...overrides,
  }
}

function reviewer(login: string, overrides: Partial<PullReviewer> = {}): PullReviewer {
  return { login, kind: 'user', pending: false, ...overrides }
}

const pendingUser = (login: string, requestedAt?: string): PullReviewer =>
  reviewer(login, { pending: true, requestedAt })
const pendingTeam = (slug: string, requestedAt?: string): PullReviewer =>
  reviewer(slug, { kind: 'team', pending: true, requestedAt })
const opinion = (
  login: string,
  reviewState: PullReviewer['reviewState'],
  reviewedAt: string,
): PullReviewer => reviewer(login, { reviewState, reviewedAt })

function snapshot(overrides: Partial<PullsSnapshot> = {}): PullsSnapshot {
  return {
    available: true,
    repo: 'acme/widgets',
    viewer: 'stephanie',
    branchPulls: [],
    authored: [],
    reviewRequested: [],
    hasMore: false,
    ...overrides,
  }
}

const rows = (
  overrides: Partial<PullsSnapshot>,
): readonly [number, string, string, number][] =>
  pullWaitRows(snapshot(overrides), NOW).map((row) => [
    row.pull.number,
    row.list,
    row.reason,
    row.since,
  ])

describe('laterOf', () => {
  it.each([
    [undefined, undefined, undefined],
    [3, undefined, 3],
    [undefined, 4, 4],
    [3, 4, 4],
    [9, 4, 9],
  ])('picks the later of %s and %s', (a, b, expected) => {
    expect(laterOf(a, b)).toBe(expected)
  })
})

describe('pullHandle', () => {
  it.each([
    ['acme/core', '@core'],
    ['ann', '@ann'],
  ])('reads %s as %s', (name, expected) => {
    expect(pullHandle(name)).toBe(expected)
  })
})

describe('deriveHolders', () => {
  it.each([
    [
      'a draft',
      pull(1, { draft: true, reviewers: [pendingUser('ann', REQUESTED)] }),
      'draft',
      [],
    ],
    [
      'pending reviewers, one holder each',
      pull(1, {
        reviewers: [pendingUser('ann', REQUESTED), pendingTeam('acme/core', READY)],
      }),
      'review',
      [
        { person: 'ann', kind: 'user', since: at(REQUESTED) },
        { person: 'acme/core', kind: 'team', since: at(READY) },
      ],
    ],
    [
      'a request older than the last ready-for-review',
      pull(1, { readyForReviewAt: READY, reviewers: [pendingUser('ann', CREATED)] }),
      'review',
      [{ person: 'ann', kind: 'user', since: at(READY) }],
    ],
    [
      'a request without a timestamp falls back to creation',
      pull(1, { reviewers: [pendingUser('ann')] }),
      'review',
      [{ person: 'ann', kind: 'user', since: at(CREATED) }],
    ],
    [
      'a pending re-request outranks standing changes requested',
      pull(1, {
        review: 'changes-requested',
        reviewers: [
          reviewer('ann', {
            pending: true,
            requestedAt: REQUESTED,
            reviewState: 'changes-requested',
            reviewedAt: READY,
          }),
        ],
      }),
      'review',
      [{ person: 'ann', kind: 'user', since: at(REQUESTED) }],
    ],
    [
      'changes requested held by the author since the latest such review',
      pull(1, {
        review: 'changes-requested',
        reviewers: [
          opinion('ann', 'changes-requested', READY),
          opinion('bob', 'changes-requested', REVIEWED),
          opinion('cy', 'approved', REQUESTED),
        ],
      }),
      'changes',
      [{ person: 'stephanie', kind: 'author', since: at(REVIEWED) }],
    ],
    [
      'approval held by the author since the latest approval',
      pull(1, {
        review: 'approved',
        reviewers: [
          opinion('ann', 'approved', REQUESTED),
          opinion('bob', 'approved', REVIEWED),
        ],
      }),
      'approved',
      [{ person: 'stephanie', kind: 'author', since: at(REVIEWED) }],
    ],
    [
      'approval without a review decision, as in a repo without required reviews',
      pull(1, { review: 'none', reviewers: [opinion('ann', 'approved', REVIEWED)] }),
      'approved',
      [{ person: 'stephanie', kind: 'author', since: at(REVIEWED) }],
    ],
    [
      'an approval short of a required-review decision still waits on nobody',
      pull(1, {
        review: 'review-required',
        readyForReviewAt: READY,
        reviewers: [opinion('ann', 'approved', REVIEWED)],
      }),
      'unassigned',
      [{ kind: 'nobody', since: at(READY) }],
    ],
    [
      'a request whose timestamp does not parse falls back to creation',
      pull(1, { reviewers: [pendingUser('ann', 'not-a-date')] }),
      'review',
      [{ person: 'ann', kind: 'user', since: at(CREATED) }],
    ],
    [
      'approval without a dated review falls back to ready-for-review',
      pull(1, { review: 'approved', readyForReviewAt: READY }),
      'approved',
      [{ person: 'stephanie', kind: 'author', since: at(READY) }],
    ],
    [
      'nobody since ready-for-review',
      pull(1, { readyForReviewAt: READY }),
      'unassigned',
      [{ kind: 'nobody', since: at(READY) }],
    ],
    [
      'nobody since creation',
      pull(1),
      'unassigned',
      [{ kind: 'nobody', since: at(CREATED) }],
    ],
    [
      'nobody since now when no date parses',
      pull(1, { createdAt: 'yesterday' }),
      'unassigned',
      [{ kind: 'nobody', since: NOW }],
    ],
  ])('derives %s', (_label, summary, status, holders) => {
    expect(deriveHolders(summary, NOW)).toEqual({ status, holders })
  })
})

describe('pullWaitRows for inbound asks', () => {
  const inbound = (overrides: Partial<PullSummary> = {}): PullSummary =>
    pull(7, { author: 'ann', ...overrides })

  it.each([
    [
      'a direct request',
      inbound({ reviewers: [pendingUser('stephanie', REQUESTED)] }),
      'Requested',
      at(REQUESTED),
    ],
    [
      'a direct re-request after the viewer reviewed',
      inbound({
        viewerReviewedAt: READY,
        reviewers: [pendingUser('stephanie', REQUESTED)],
      }),
      'Re-requested',
      at(REQUESTED),
    ],
    [
      'a direct request whose viewerReviewedAt does not parse',
      inbound({
        viewerReviewedAt: 'not-a-date',
        reviewers: [pendingUser('stephanie', REQUESTED)],
      }),
      'Requested',
      at(REQUESTED),
    ],
    [
      'a direct request before ready-for-review',
      inbound({
        readyForReviewAt: READY,
        reviewers: [pendingUser('stephanie', CREATED)],
      }),
      'Requested',
      at(READY),
    ],
    [
      'a team request',
      inbound({ reviewers: [pendingTeam('acme/core', REQUESTED)] }),
      'via @core',
      at(REQUESTED),
    ],
    [
      'several team requests, since the earliest',
      inbound({
        reviewers: [
          pendingTeam('acme/core', REVIEWED),
          pendingTeam('acme/infra', REQUESTED),
        ],
      }),
      'via @core, @infra',
      at(REQUESTED),
    ],
    [
      'an assignment',
      inbound({ viewerAssignedAt: REQUESTED }),
      'Assigned',
      at(REQUESTED),
    ],
    [
      'a bare review-requested listing since ready-for-review',
      inbound({ readyForReviewAt: READY }),
      'Requested',
      at(READY),
    ],
    [
      'a bare review-requested listing since creation',
      inbound(),
      'Requested',
      at(CREATED),
    ],
  ])('lists %s under needs', (_label, summary, reason, since) => {
    expect(rows({ reviewRequested: [summary] })).toEqual([[7, 'needs', reason, since]])
  })

  it.each([
    [
      'a team request the viewer already answered',
      inbound({
        viewerReviewedAt: REVIEWED,
        reviewers: [pendingTeam('acme/core', REQUESTED)],
      }),
    ],
    [
      'an assignment the viewer already answered',
      inbound({ viewerAssignedAt: REQUESTED, viewerReviewedAt: REQUESTED }),
    ],
    [
      'a draft asking for review',
      inbound({ draft: true, reviewers: [pendingUser('stephanie', REQUESTED)] }),
    ],
    [
      'a merged pull request',
      inbound({ state: 'merged', reviewers: [pendingUser('stephanie', REQUESTED)] }),
    ],
  ])('skips %s', (_label, summary) => {
    expect(rows({ reviewRequested: [summary] })).toEqual([])
  })

  it('keeps a direct re-request the viewer answered before', () => {
    const summary = inbound({
      viewerReviewedAt: REVIEWED,
      reviewers: [pendingUser('stephanie', REQUESTED)],
    })
    expect(rows({ reviewRequested: [summary] })).toEqual([
      [7, 'needs', 'Re-requested', at(REQUESTED)],
    ])
  })
})

describe('pullWaitRows for authored pull requests', () => {
  it.each([
    ['a draft', pull(3, { draft: true }), 'drafts', 'Draft', at('2026-10-10T00:00:00Z')],
    [
      'failing CI since the head commit',
      pull(3, {
        checks: 'failing',
        headCommittedAt: REVIEWED,
        reviewers: [pendingUser('ann', REQUESTED)],
      }),
      'needs',
      'CI failing',
      at(REVIEWED),
    ],
    [
      'failing CI without a head commit date',
      pull(3, { checks: 'failing' }),
      'needs',
      'CI failing',
      at('2026-10-10T00:00:00Z'),
    ],
    [
      'an approval',
      pull(3, { review: 'approved', reviewers: [opinion('ann', 'approved', REVIEWED)] }),
      'needs',
      'Ready to merge',
      at(REVIEWED),
    ],
    [
      'changes requested',
      pull(3, {
        review: 'changes-requested',
        reviewers: [opinion('ann', 'changes-requested', REVIEWED)],
      }),
      'needs',
      'Changes requested',
      at(REVIEWED),
    ],
    [
      'no reviewer',
      pull(3, { readyForReviewAt: READY }),
      'needs',
      'No reviewer yet',
      at(READY),
    ],
    [
      'a pending user review',
      pull(3, { reviewers: [pendingUser('ann', REQUESTED)] }),
      'waiting',
      'Waiting',
      at(REQUESTED),
    ],
    [
      'a pending review held by one team',
      pull(3, { reviewers: [pendingTeam('acme/core', REQUESTED)] }),
      'waiting',
      'via @core',
      at(REQUESTED),
    ],
    [
      'pending reviews held by a team and a person',
      pull(3, {
        reviewers: [pendingTeam('acme/core', REVIEWED), pendingUser('ann', REQUESTED)],
      }),
      'waiting',
      'Waiting',
      at(REQUESTED),
    ],
  ])('lists %s', (_label, summary, list, reason, since) => {
    expect(rows({ authored: [summary] })).toEqual([[3, list, reason, since]])
  })

  it('names whom a waiting pull request waits on', () => {
    const [row] = pullWaitRows(
      snapshot({
        authored: [
          pull(3, {
            reviewers: [
              pendingTeam('acme/core', REVIEWED),
              pendingUser('ann', REQUESTED),
            ],
          }),
        ],
      }),
      NOW,
    )
    expect(row?.waitingOn).toEqual(['acme/core', 'ann'])
  })

  it('skips closed pull requests', () => {
    expect(rows({ authored: [pull(3, { state: 'closed' })] })).toEqual([])
  })
})

describe('pullWaitRows ordering', () => {
  it('lists needs and waiting oldest first and drafts newest first', () => {
    const listed = rows({
      reviewRequested: [
        pull(1, { author: 'ann', reviewers: [pendingUser('stephanie', REVIEWED)] }),
      ],
      authored: [
        pull(2, { draft: true, updatedAt: READY }),
        pull(3, { reviewers: [pendingUser('ann', REVIEWED)] }),
        pull(4, { readyForReviewAt: READY }),
        pull(5, { draft: true, updatedAt: REQUESTED }),
        pull(6, { reviewers: [pendingUser('ann', REQUESTED)] }),
      ],
    })
    expect(listed).toEqual([
      [4, 'needs', 'No reviewer yet', at(READY)],
      [1, 'needs', 'Requested', at(REVIEWED)],
      [6, 'waiting', 'Waiting', at(REQUESTED)],
      [3, 'waiting', 'Waiting', at(REVIEWED)],
      [5, 'drafts', 'Draft', at(REQUESTED)],
      [2, 'drafts', 'Draft', at(READY)],
    ])
  })

  it('lists a pull request found in both sections once, as authored', () => {
    const own = pull(9, { reviewers: [pendingUser('ann', REQUESTED)] })
    expect(rows({ reviewRequested: [own], authored: [own] })).toEqual([
      [9, 'waiting', 'Waiting', at(REQUESTED)],
    ])
  })
})
