import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import {
  ageLabel,
  ageTone,
  checksLabel,
  pullSections,
  reviewLabel,
  unavailableHint,
} from '../src/renderer/src/github/pulls-model'
import type {
  PullReviewer,
  PullSummary,
  PullsSnapshot,
  PullsUnavailableReason,
} from '../src/shared'

/** October 2026, local time: the 9th is a Friday, the 12th the Monday after. */
const october = (day: number, hour = 0): number => new Date(2026, 9, day, hour).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const NOW = october(12, 17)

function pull(number: number, overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'open',
    draft: false,
    headRef: `branch-${number}`,
    author: 'stephanie',
    createdAt: iso(october(1, 9)),
    updatedAt: iso(october(2, 9 + (number % 12))),
    checks: 'passing',
    review: 'none',
    openFeedback: 0,
    reviewers: [],
    ...overrides,
  }
}

const pendingUser = (login: string, requestedAt: number): PullReviewer => ({
  login,
  kind: 'user',
  pending: true,
  requestedAt: iso(requestedAt),
})

const pendingTeam = (slug: string, requestedAt: number): PullReviewer => ({
  login: slug,
  kind: 'team',
  pending: true,
  requestedAt: iso(requestedAt),
})

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

const numbersOf = (
  sections: ReturnType<typeof pullSections>,
): readonly (readonly [string, readonly number[]])[] =>
  sections.map((section) => [section.key, section.rows.map((row) => row.pull.number)])

describe('pullSections', () => {
  it('labels the four sections in rail order', () => {
    expect(pullSections(snapshot(), NOW).map((section) => section.label)).toEqual([
      'This branch',
      'Needs you',
      'Waiting',
      'Drafts',
    ])
  })

  it('shows each pull once, preferring branch, then its wait list', () => {
    const sections = pullSections(
      snapshot({
        branchPulls: [pull(1)],
        reviewRequested: [
          pull(2, { author: 'ben', reviewers: [pendingUser('stephanie', october(6))] }),
          pull(1),
        ],
        authored: [
          pull(3, { reviewers: [pendingUser('ben', october(7))] }),
          pull(4, { draft: true }),
          pull(2),
          pull(1),
        ],
      }),
      NOW,
    )
    expect(numbersOf(sections)).toEqual([
      ['branch', [1]],
      ['needs', [2]],
      ['waiting', [3]],
      ['drafts', [4]],
    ])
  })

  it('orders branch pulls open first then newest, and gives them their wait reason', () => {
    const [branch] = pullSections(
      snapshot({
        branchPulls: [
          pull(1, { state: 'merged', updatedAt: iso(october(9)) }),
          pull(2, { updatedAt: iso(october(1)) }),
          pull(3, { updatedAt: iso(october(8)), checks: 'failing' }),
        ],
        authored: [pull(3, { checks: 'failing', headCommittedAt: iso(october(7, 11)) })],
      }),
      NOW,
    )
    expect(branch?.rows.map((row) => row.pull.number)).toEqual([3, 2, 1])
    expect(branch?.rows[0]).toMatchObject({
      reason: 'CI failing',
      since: october(7, 11),
      waitingOn: [],
    })
    expect(branch?.rows[1]).toMatchObject({ reason: '', waitingOn: [] })
    expect(branch?.rows[1]?.since).toBeUndefined()
  })

  it('ranks Needs you oldest ask first, not by update time', () => {
    const [, needs] = pullSections(
      snapshot({
        reviewRequested: [
          pull(5, {
            author: 'ben',
            updatedAt: iso(october(2)),
            reviewers: [pendingUser('stephanie', october(8, 10))],
          }),
          pull(6, {
            author: 'cara',
            updatedAt: iso(october(11)),
            reviewers: [pendingTeam('acme/platform', october(6, 15))],
          }),
        ],
        authored: [pull(7, { review: 'approved', readyForReviewAt: iso(october(7, 9)) })],
      }),
      NOW,
    )
    expect(needs?.rows.map((row) => [row.pull.number, row.reason, row.since])).toEqual([
      [6, 'via @platform', october(6, 15)],
      [7, 'Ready to merge', october(7, 9)],
      [5, 'Requested', october(8, 10)],
    ])
  })

  it('names who a waiting pull is held by', () => {
    const [, , waiting] = pullSections(
      snapshot({
        authored: [
          pull(8, {
            reviewers: [
              pendingUser('ben', october(8, 12)),
              pendingTeam('acme/platform', october(7, 12)),
            ],
          }),
        ],
      }),
      NOW,
    )
    expect(waiting?.rows[0]).toMatchObject({
      reason: 'Waiting',
      since: october(7, 12),
      waitingOn: ['ben', 'acme/platform'],
    })
  })

  it('carries the shared wait row into a section row without its list', () => {
    const held = pull(8, { reviewers: [pendingUser('ben', october(8, 12))] })
    const [branch, , waiting] = pullSections(
      snapshot({ branchPulls: [held], authored: [held, pull(11)] }),
      NOW,
    )
    const expected = {
      pull: held,
      reason: 'Waiting',
      since: october(8, 12),
      waitingOn: ['ben'],
    }
    expect(branch?.rows[0]).toEqual(expected)
    expect(waiting?.rows).toEqual([])
    const [, needs] = pullSections(snapshot({ authored: [held, pull(11)] }), NOW)
    expect(needs?.rows[0]).toEqual({
      pull: pull(11),
      reason: 'No reviewer yet',
      since: october(1, 9),
      waitingOn: [],
    })
  })

  it('lists drafts newest first', () => {
    const [, , , drafts] = pullSections(
      snapshot({
        authored: [
          pull(9, { draft: true, updatedAt: iso(october(3)) }),
          pull(10, { draft: true, updatedAt: iso(october(9)) }),
        ],
      }),
      NOW,
    )
    expect(drafts?.rows.map((row) => row.pull.number)).toEqual([10, 9])
  })

  it('partitions its open input without losing or repeating a pull', () => {
    hegel.test((testCase) => {
      const numbers = generators.arrays(
        generators.integers({ minValue: 1, maxValue: 12 }),
        {
          maxSize: 10,
        },
      )
      const branch = testCase.draw(numbers).map((n) => pull(n))
      const review = testCase.draw(numbers).map((n) => pull(n, { author: 'ben' }))
      const authored = testCase.draw(numbers).map((n) => pull(n))
      const shown = pullSections(
        snapshot({ branchPulls: branch, reviewRequested: review, authored }),
        NOW,
      ).flatMap((section) => section.rows.map((row) => row.pull.number))
      const expected = new Set([...branch, ...review, ...authored].map((p) => p.number))
      expect(shown).toHaveLength(expected.size)
      expect(new Set(shown)).toEqual(expected)
    })
  })
})

describe('age chip', () => {
  it('counts a Friday evening request as one business day on Monday evening', () => {
    expect(ageLabel(october(9, 17), NOW)).toBe('1d')
    expect(ageTone(october(9, 17), NOW)).toBe('amber')
  })

  it('tones by business days', () => {
    const halfHourAgo = october(12, 16) + 30 * 60_000
    expect(ageLabel(halfHourAgo, NOW)).toBe('30m')
    expect(ageTone(halfHourAgo, NOW)).toBe('neutral')
    expect(ageLabel(october(12, 9), NOW)).toBe('8h')
    expect(ageLabel(october(7, 17), NOW)).toBe('3d')
    expect(ageTone(october(7, 17), NOW)).toBe('red')
  })
})

describe('labels', () => {
  it('names checks and reviews, and says nothing when there is nothing', () => {
    expect(checksLabel('passing')).toBe('CI passing')
    expect(checksLabel('failing')).toBe('CI failing')
    expect(checksLabel('pending')).toBe('CI running')
    expect(checksLabel('none')).toBe('')
    expect(reviewLabel('approved')).toBe('Approved')
    expect(reviewLabel('changes-requested')).toBe('Changes requested')
    expect(reviewLabel('review-required')).toBe('Review required')
    expect(reviewLabel('none')).toBe('')
  })

  it('gives every unavailable reason a remedy', () => {
    const reasons: readonly PullsUnavailableReason[] = [
      'gh-missing',
      'gh-unauthenticated',
      'gh-remote-unauthenticated',
      'no-github-repo',
      'rate-limited',
      'error',
    ]
    for (const reason of reasons) {
      expect(unavailableHint({ available: false, reason, message: 'detail' })).not.toBe(
        '',
      )
    }
    expect(
      unavailableHint({ available: false, reason: 'gh-unauthenticated', message: '' }),
    ).toMatch(/gh auth login/)
    expect(
      unavailableHint({
        available: false,
        reason: 'gh-remote-unauthenticated',
        message: '',
      }),
    ).toMatch(/gh auth login --insecure-storage/)
  })
})
