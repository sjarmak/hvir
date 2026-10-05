import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import {
  checksLabel,
  pullSections,
  reviewLabel,
  unavailableHint,
} from '../src/renderer/src/github/pulls-model'
import type { PullSummary, PullsSnapshot, PullsUnavailableReason } from '../src/shared'

function pull(number: number, overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'open',
    draft: false,
    headRef: `branch-${number}`,
    author: 'stephanie',
    updatedAt: `2026-09-${String(10 + (number % 20)).padStart(2, '0')}T00:00:00Z`,
    checks: 'none',
    review: 'none',
    openFeedback: 0,
    ...overrides,
  }
}

function snapshot(overrides: Partial<PullsSnapshot> = {}): PullsSnapshot {
  return {
    available: true,
    repo: 'acme/widgets',
    viewer: 'stephanie',
    branchPulls: [],
    authored: [],
    reviewRequested: [],
    ...overrides,
  }
}

describe('pullSections', () => {
  it('shows each pull once, preferring branch, then review, then authored', () => {
    const sections = pullSections(
      snapshot({
        branchPulls: [pull(1)],
        reviewRequested: [pull(2), pull(1)],
        authored: [pull(3), pull(2), pull(1)],
      }),
    )
    expect(
      sections.map((section) => [section.key, section.pulls.map((p) => p.number)]),
    ).toEqual([
      ['branch', [1]],
      ['review', [2]],
      ['authored', [3]],
    ])
  })

  it('orders open pulls before closed ones, then newest first', () => {
    const [branch] = pullSections(
      snapshot({
        branchPulls: [
          pull(1, { state: 'merged', updatedAt: '2026-09-30T00:00:00Z' }),
          pull(2, { updatedAt: '2026-09-01T00:00:00Z' }),
          pull(3, { updatedAt: '2026-09-20T00:00:00Z' }),
        ],
      }),
    )
    expect(branch?.pulls.map((p) => p.number)).toEqual([3, 2, 1])
  })

  it('partitions its input without losing or repeating a pull', () => {
    hegel.test((testCase) => {
      const numbers = generators.arrays(
        generators.integers({ minValue: 1, maxValue: 12 }),
        {
          maxSize: 10,
        },
      )
      const branch = testCase.draw(numbers).map((n) => pull(n))
      const review = testCase.draw(numbers).map((n) => pull(n))
      const authored = testCase.draw(numbers).map((n) => pull(n))
      const shown = pullSections(
        snapshot({ branchPulls: branch, reviewRequested: review, authored }),
      ).flatMap((section) => section.pulls.map((p) => p.number))
      const expected = new Set([...branch, ...review, ...authored].map((p) => p.number))
      expect(shown).toHaveLength(expected.size)
      expect(new Set(shown)).toEqual(expected)
    })
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
