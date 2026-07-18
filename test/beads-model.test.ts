import { describe, expect, it } from 'vitest'

import {
  groupBeads,
  priorityLabel,
  sortBeads,
} from '../src/renderer/src/beads/beads-model'
import type { BeadIssue } from '../src/shared'

function issue(overrides: Partial<BeadIssue> & { readonly id: string }): BeadIssue {
  return {
    title: overrides.id,
    status: 'open',
    priority: 2,
    issueType: 'task',
    labels: [],
    dependencyCount: 0,
    dependentCount: 0,
    ...overrides,
  }
}

describe('groupBeads', () => {
  it('partitions by status with ready separated from blocked open work', () => {
    const sections = groupBeads(
      [
        issue({ id: 'a', status: 'in_progress' }),
        issue({ id: 'b', status: 'open' }),
        issue({ id: 'c', status: 'open' }),
        issue({ id: 'd', status: 'blocked' }),
        issue({ id: 'e', status: 'deferred' }),
      ],
      ['b'],
    )
    const byKey = Object.fromEntries(
      sections.map((section) => [section.key, section.issues.map((entry) => entry.id)]),
    )
    expect(byKey).toEqual({
      inProgress: ['a'],
      ready: ['b'],
      blocked: ['d'],
      open: ['c'],
      deferred: ['e'],
    })
  })

  it('routes unknown statuses to the open section instead of dropping them', () => {
    const sections = groupBeads([issue({ id: 'x', status: 'hoisted' })], [])
    expect(sections.find((section) => section.key === 'open')?.issues).toHaveLength(1)
  })
})

describe('sortBeads', () => {
  it('orders by priority, then recency, then id, without mutating input', () => {
    const input = [
      issue({ id: 'late', priority: 2, updatedAt: '2026-07-01T00:00:00Z' }),
      issue({ id: 'urgent', priority: 0 }),
      issue({ id: 'fresh', priority: 2, updatedAt: '2026-07-10T00:00:00Z' }),
    ]
    const sorted = sortBeads(input)
    expect(sorted.map((entry) => entry.id)).toEqual(['urgent', 'fresh', 'late'])
    expect(input[0]?.id).toBe('late')
  })
})

describe('priorityLabel', () => {
  it('formats known priorities and shields nonsense', () => {
    expect(priorityLabel(0)).toBe('P0')
    expect(priorityLabel(4)).toBe('P4')
    expect(priorityLabel(-1)).toBe('P?')
    expect(priorityLabel(2.5)).toBe('P?')
  })
})
