import { describe, expect, it } from 'vitest'

import {
  classifyBeads,
  priorityLabel,
  sortBeads,
  type BeadsSectionKey,
  type BeadsView,
} from '../src/renderer/src/beads/beads-model'
import type { BeadGate, BeadIssue, BeadsSnapshot } from '../src/shared'

function issue(overrides: Partial<BeadIssue> & { readonly id: string }): BeadIssue {
  return {
    title: `Title ${overrides.id}`,
    status: 'open',
    priority: 2,
    issueType: 'task',
    labels: [],
    dependencyCount: 0,
    dependentCount: 0,
    ...overrides,
  }
}

function snapshot(overrides: Partial<BeadsSnapshot> & { readonly issues: readonly BeadIssue[] }): BeadsSnapshot {
  return {
    available: true,
    readyIds: [],
    dispatchableIds: [],
    dispatchabilitySource: 'structural',
    dependencies: [],
    gates: [],
    ...overrides,
  }
}

function section(view: BeadsView, key: BeadsSectionKey) {
  const found = view.sections.find((s) => s.key === key)
  if (!found) throw new Error(`missing section ${key}`)
  return found
}

const FIXED_NOW = Date.parse('2026-07-18T00:00:00Z')

describe('classifyBeads — Ready next', () => {
  it('shows exactly one Ready next when the predicate supplies dispatchability', () => {
    // Acceptance fixture 10: 47 dependency-ready, exactly one scheduler-dispatchable.
    const issues = Array.from({ length: 47 }, (_, i) => issue({ id: `leaf-${i}` }))
    const view = classifyBeads(
      snapshot({
        issues,
        readyIds: issues.map((i) => i.id),
        dispatchableIds: ['leaf-0'],
        dispatchabilitySource: 'predicate',
      }),
    )
    const readyNext = section(view, 'readyNext')
    expect(readyNext.label).toBe('Ready next')
    expect(readyNext.cards.map((c) => c.issue.id)).toEqual(['leaf-0'])
    // The other 46 dependency-ready records are planned, never in the executable queue.
    expect(section(view, 'planned').count).toBe(46)
  })

  it('does not present a structural approximation as Ready next', () => {
    // Correction 1: without a predicate the section is renamed and annotated.
    const structural = classifyBeads(
      snapshot({ issues: [issue({ id: 'a' })], readyIds: ['a'], dispatchableIds: ['a'] }),
    )
    expect(section(structural, 'readyNext').label).toBe('Dependency-ready / needs classification')
    expect(section(structural, 'readyNext').note).toMatch(/structural approximation/i)

    const predicate = classifyBeads(
      snapshot({
        issues: [issue({ id: 'a' })],
        readyIds: ['a'],
        dispatchableIds: ['a'],
        dispatchabilitySource: 'predicate',
      }),
    )
    expect(section(predicate, 'readyNext').label).toBe('Ready next')
    expect(section(predicate, 'readyNext').note).toBeUndefined()
  })
})

describe('classifyBeads — containers never inflate human counts', () => {
  it('hides orchestration/infra/gate types and keeps epics as planned outcomes', () => {
    // Acceptance test 2.
    const issues = [
      issue({ id: 'leaf', issueType: 'task' }),
      issue({ id: 'epic', issueType: 'epic' }),
      issue({ id: 'convoy', issueType: 'convoy' }),
      issue({ id: 'mol', issueType: 'molecule' }),
      issue({ id: 'infra', issueType: 'agent' }),
    ]
    const view = classifyBeads(
      snapshot({ issues, readyIds: ['leaf'], dispatchableIds: ['leaf'] }),
    )
    expect(section(view, 'readyNext').count).toBe(1)
    // convoy/molecule/infra are hidden orchestration; epic is a planned outcome.
    expect(view.orchestrationIssues.map((i) => i.id).sort()).toEqual(['convoy', 'infra', 'mol'])
    expect(section(view, 'planned').groups?.map((g) => g.outcome.id)).toEqual(['epic'])
  })
})

describe('classifyBeads — human / deferred / ship / blocked routing', () => {
  it('routes non-executable work by deterministic precedence, never to Ready next', () => {
    // Corrections 2, 3, 6: decision→Needs you, merge-request→Ready to ship,
    // deferred→Planned, blocked→Blocked. Even if the scheduler wrongly listed
    // them dispatchable, typed type/status/edge signals win.
    const issues = [
      issue({ id: 'dec', issueType: 'decision' }),
      issue({ id: 'ship', issueType: 'merge-request' }),
      issue({ id: 'deferred', status: 'deferred' }),
      issue({ id: 'blocked', status: 'blocked' }),
    ]
    const view = classifyBeads(
      snapshot({
        issues,
        readyIds: ['dec', 'ship', 'deferred'],
        dispatchableIds: ['dec', 'ship', 'deferred'],
      }),
    )
    expect(section(view, 'readyNext').count).toBe(0)
    expect(section(view, 'needsYou').cards.map((c) => c.issue.id)).toEqual(['dec'])
    expect(section(view, 'readyToShip').cards.map((c) => c.issue.id)).toEqual(['ship'])
    expect(section(view, 'planned').cards.map((c) => c.issue.id)).toEqual(['deferred'])
    expect(section(view, 'blocked').cards.map((c) => c.issue.id)).toEqual(['blocked'])
  })

  it('routes branch-ready / no-land work to Ready to ship via typed metadata', () => {
    // Correction 6 + 9: driven by gc.outcome / gc.no_land, never prose.
    const issues = [
      issue({ id: 'branch', metadata: { 'gc.outcome': 'branch-ready' } }),
      issue({ id: 'noland', metadata: { 'gc.no_land': '1' } }),
      issue({ id: 'plain' }),
    ]
    const view = classifyBeads(
      snapshot({ issues, readyIds: ['branch', 'noland', 'plain'], dispatchableIds: ['branch', 'noland', 'plain'] }),
    )
    const ship = section(view, 'readyToShip')
    expect(ship.cards.map((c) => c.issue.id).sort()).toEqual(['branch', 'noland'])
    expect(ship.cards.find((c) => c.issue.id === 'branch')?.shipState).toBe('Branch ready')
    expect(ship.cards.find((c) => c.issue.id === 'noland')?.shipState).toMatch(/no-land/i)
    // Only the plain leaf remains a candidate for the executable queue.
    expect(section(view, 'readyNext').cards.map((c) => c.issue.id)).toEqual(['plain'])
  })

  it('routes a needs-human labelled bead to Needs you', () => {
    const view = classifyBeads(
      snapshot({
        issues: [issue({ id: 'hitl', labels: ['needs-human'] })],
        readyIds: ['hitl'],
        dispatchableIds: ['hitl'],
      }),
    )
    expect(section(view, 'needsYou').cards.map((c) => c.issue.id)).toEqual(['hitl'])
    expect(section(view, 'readyNext').count).toBe(0)
  })

  it('surfaces gates under Needs you with what they unblock', () => {
    const gates: BeadGate[] = [
      { id: 'g1', title: 'Approve release', gateType: 'human', blockedId: 'ship', state: 'open' },
    ]
    const view = classifyBeads(
      snapshot({ issues: [issue({ id: 'ship', issueType: 'merge-request' })], gates }),
    )
    expect(view.gates).toHaveLength(1)
    expect(view.gates[0]?.blocks?.title).toBe('Title ship')
  })
})

describe('classifyBeads — in-flight liveness', () => {
  it('distinguishes a live owner from a stale or dead assignment', () => {
    // Acceptance test 5.
    const issues = [
      issue({
        id: 'live',
        status: 'in_progress',
        assignee: 'stephanie',
        updatedAt: '2026-07-17T20:00:00Z', // 4h before FIXED_NOW
      }),
      issue({
        id: 'stale',
        status: 'in_progress',
        assignee: 'stephanie',
        updatedAt: '2026-07-10T00:00:00Z', // 8 days before
      }),
      issue({ id: 'dead', status: 'in_progress' }), // no owner
    ]
    const view = classifyBeads(snapshot({ issues }), { now: FIXED_NOW })
    const byId = Object.fromEntries(
      section(view, 'inFlight').cards.map((c) => [c.issue.id, c.liveness]),
    )
    expect(byId).toEqual({ live: 'live', stale: 'stale', dead: 'stale' })
  })
})

describe('classifyBeads — dependency cards', () => {
  it('resolves blocker titles + state and inverts edges for unlock counts', () => {
    // Acceptance test 6.
    const issues = [
      issue({ id: 'blocker', status: 'in_progress', assignee: 'alex' }),
      issue({ id: 'work', status: 'blocked' }),
      issue({ id: 'downstream-1' }),
      issue({ id: 'downstream-2' }),
    ]
    const view = classifyBeads(
      snapshot({
        issues,
        dependencies: [
          { blockerId: 'blocker', blockedId: 'work' },
          { blockerId: 'work', blockedId: 'downstream-1' },
          { blockerId: 'work', blockedId: 'downstream-2' },
        ],
      }),
    )
    const card = section(view, 'blocked').cards.find((c) => c.issue.id === 'work')
    if (!card) throw new Error('expected blocked card')
    expect(card.blockedBy).toEqual([{ id: 'blocker', title: 'Title blocker', status: 'in_progress' }])
    expect(card.unlocksCount).toBe(2)
    expect(card.nextUnblock).toEqual({ action: 'Resolve “Title blocker”', owner: 'alex' })
  })

  it('routes an open bead with unresolved blockers to Blocked, not Ready next', () => {
    const issues = [issue({ id: 'blocker' }), issue({ id: 'work', status: 'open' })]
    const view = classifyBeads(
      snapshot({
        issues,
        readyIds: [], // not dependency-ready because it has a blocker
        dependencies: [{ blockerId: 'blocker', blockedId: 'work' }],
      }),
    )
    expect(section(view, 'blocked').cards.map((c) => c.issue.id)).toContain('work')
    expect(section(view, 'readyNext').count).toBe(0)
  })

  it('trusts an open blocker over an over-broad ready/dispatchable list', () => {
    // Degraded/split store: bd reports a blocked bead as ready AND the scheduler
    // marks it dispatchable, yet a blocking edge is plainly open. The graph wins.
    const issues = [
      issue({ id: 'blocker', status: 'open' }),
      issue({ id: 'work', status: 'open' }),
    ]
    const view = classifyBeads(
      snapshot({
        issues,
        readyIds: ['blocker', 'work'],
        dispatchableIds: ['work'],
        dependencies: [{ blockerId: 'blocker', blockedId: 'work' }],
      }),
    )
    expect(section(view, 'blocked').cards.map((c) => c.issue.id)).toEqual(['work'])
    expect(section(view, 'readyNext').cards.map((c) => c.issue.id)).not.toContain('work')
  })
})

describe('classifyBeads — data hygiene', () => {
  it('surfaces unknown types instead of treating them as executable', () => {
    // Acceptance test 7.
    const issues = [
      issue({ id: 'known', issueType: 'task' }),
      issue({ id: 'weird', issueType: 'wibble' }),
    ]
    const view = classifyBeads(
      snapshot({ issues, readyIds: ['known', 'weird'], dispatchableIds: ['known', 'weird'] }),
    )
    expect(view.dataHygiene.map((i) => i.id)).toEqual(['weird'])
    expect(section(view, 'readyNext').cards.map((c) => c.issue.id)).toEqual(['known'])
  })
})

describe('classifyBeads — backward compatibility', () => {
  it('renders an old-shape snapshot missing the enrichment fields', () => {
    // A main process that predates the new fields returns only issues + readyIds.
    const legacy = {
      available: true,
      issues: [issue({ id: 'a', status: 'in_progress' }), issue({ id: 'b' })],
      readyIds: ['b'],
    } as unknown as BeadsSnapshot
    const view = classifyBeads(legacy)
    expect(section(view, 'inFlight').cards.map((c) => c.issue.id)).toEqual(['a'])
    expect(view.dependencies).toEqual([])
    expect(view.gates).toEqual([])
    // No dispatchableIds ⇒ nothing is "next", so ready work is planned, not lost.
    expect(section(view, 'readyNext').count).toBe(0)
    expect(section(view, 'planned').cards.map((c) => c.issue.id)).toContain('b')
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
