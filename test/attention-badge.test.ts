import { describe, expect, it, vi } from 'vitest'

import { ActionableAttentionSet } from '../src/main/attention/actionable-attention-set'
import { AttentionBadge } from '../src/main/attention-badge'
import {
  asHostId,
  asSessionsTerminalHandle,
  type ActionableAttentionEntry,
} from '../src/shared'

const owner = (id: number, generation = 1) => ({ id, generation })

const entry = (handle: string): ActionableAttentionEntry => ({
  handle: asSessionsTerminalHandle(handle),
  kind: 'ready',
  freshness: 'fresh',
})

function harness(setBadgeCount = vi.fn<(count: number) => boolean>(() => true)) {
  const set = new ActionableAttentionSet()
  const badge = new AttentionBadge(setBadgeCount, set)
  return { set, badge, counts: () => setBadgeCount.mock.calls.map(([count]) => count) }
}

describe('AttentionBadge', () => {
  it('shows fresh actionable entries only while hvir is away', () => {
    const { set, counts } = harness()

    set.setFocused(owner(1), true)
    set.setRendererEntries(owner(1), [entry('t1'), entry('t2')])
    expect(counts()).toEqual([0])

    set.setFocused(owner(1), false)
    set.setRendererEntries(owner(2), [entry('t3')])
    expect(counts()).toEqual([0, 2, 3])

    set.setFocused(owner(2), true)
    expect(counts().at(-1)).toBe(0)
    set.removeOwner(2)
    expect(counts().at(-1)).toBe(2)
  })

  it('counts an external entry with no window open at all', () => {
    const { set, counts } = harness()
    set.setExternal([
      {
        key: 'gas-city host-a s1',
        kind: 'ready',
        freshness: 'fresh',
        external: { sourceId: 'gas-city', hostId: asHostId('host-a'), key: 's1' },
      },
    ])
    expect(counts().at(-1)).toBe(1)
  })

  it('never counts a stale entry', () => {
    const { set, counts } = harness()
    set.setExternal([
      {
        key: 'gas-city host-a s1',
        kind: 'ready',
        freshness: 'stale',
        reason: 'closed',
        external: { sourceId: 'gas-city', hostId: asHostId('host-a'), key: 's1' },
      },
    ])
    expect(counts()).toEqual([0])
  })

  it('caps the badge and avoids redundant platform calls', () => {
    const { set, counts } = harness()
    const entries = Array.from({ length: 150 }, (_, index) => entry(`t${index}`))
    set.setRendererEntries(owner(1), entries)
    set.setRendererEntries(owner(1), entries)
    set.setRendererEntries(owner(2), entries.slice(0, 10))
    expect(counts()).toEqual([0, 99])
  })

  it('does not let stale generation cleanup erase current attention', () => {
    const { set, counts } = harness()
    set.setRendererEntries(owner(1, 1), [entry('t1'), entry('t2'), entry('t3')])
    set.setRendererEntries(owner(1, 2), [entry('t1'), entry('t4')])
    set.removeOwner(1, 1)
    expect(counts().at(-1)).toBe(2)
  })

  it('stops quietly when the desktop has no badge implementation', () => {
    const setBadgeCount = vi.fn<(count: number) => boolean>(() => false)
    const { set } = harness(setBadgeCount)
    set.setRendererEntries(owner(1), [entry('t1')])
    set.setRendererEntries(owner(1), [entry('t1'), entry('t2')])
    expect(setBadgeCount).toHaveBeenCalledOnce()
  })

  it('clears the OS badge and stops listening when disposed', () => {
    const { set, badge, counts } = harness()
    set.setRendererEntries(owner(1), [entry('t1')])
    badge.dispose()
    set.setRendererEntries(owner(1), [entry('t1'), entry('t2')])
    expect(counts()).toEqual([0, 1, 0])
  })
})
