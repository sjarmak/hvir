import { describe, expect, it, vi } from 'vitest'

import {
  ActionableAttentionSet,
  appearances,
  type MainActionableEntry,
} from '../src/main/attention/actionable-attention-set'
import {
  asHostId,
  asSessionsTerminalHandle,
  type ActionableAttentionEntry,
} from '../src/shared'

const owner = (id: number, generation = 1) => ({ id, generation })

const rendererEntry = (
  handle: string,
  kind: ActionableAttentionEntry['kind'] = 'ready',
): ActionableAttentionEntry => ({
  handle: asSessionsTerminalHandle(handle),
  kind,
  freshness: 'fresh',
})

const external = (
  key: string,
  freshness: MainActionableEntry['freshness'] = 'fresh',
): MainActionableEntry => ({
  key: `gas-city host-a ${key}`,
  kind: 'ready',
  freshness,
  ...(freshness === 'stale' ? { reason: 'unreachable' as const } : {}),
  external: { sourceId: 'gas-city', hostId: asHostId('host-a'), key },
})

describe('ActionableAttentionSet', () => {
  it('is away with no owners at all, so an external entry counts before a window opens', () => {
    const set = new ActionableAttentionSet()
    expect(set.away()).toBe(true)
    set.setExternal([external('s1')])
    expect(set.freshCount()).toBe(1)
    expect(set.snapshot().away).toBe(true)
  })

  it('is away exactly when no owner is focused', () => {
    const set = new ActionableAttentionSet()
    set.setFocused(owner(1), true)
    expect(set.away()).toBe(false)
    set.setFocused(owner(2), false)
    expect(set.away()).toBe(false)
    set.setFocused(owner(1), false)
    expect(set.away()).toBe(true)
    set.setFocused(owner(2), true)
    set.removeOwner(2)
    expect(set.away()).toBe(true)
  })

  it('dedupes one terminal reported by two renderer generations, newest wins', () => {
    const set = new ActionableAttentionSet()
    set.setRendererEntries(owner(1, 1), [rendererEntry('t1', 'ready')])
    set.setRendererEntries(owner(1, 2), [rendererEntry('t1', 'bell')])
    expect(set.snapshot().entries).toEqual([
      {
        key: 't1',
        kind: 'bell',
        freshness: 'fresh',
        terminalHandle: asSessionsTerminalHandle('t1'),
      },
    ])
    set.removeOwner(1, 1)
    expect(set.snapshot().entries.map((entry) => entry.kind)).toEqual(['bell'])
    set.removeOwner(1)
    expect(set.snapshot().entries).toEqual([])
  })

  it('merges working across windows, sorted and once, and an entry outranks it', () => {
    const set = new ActionableAttentionSet()
    const listener = vi.fn()
    set.observe(listener)
    set.setRendererEntries(owner(1), [], [asSessionsTerminalHandle('t2')])
    set.setRendererEntries(owner(2), [rendererEntry('t1')], [
      asSessionsTerminalHandle('t2'),
      asSessionsTerminalHandle('t1'),
      asSessionsTerminalHandle('t0'),
    ])
    expect(set.snapshot().working).toEqual(['t0', 't2'])
    expect(set.freshCount()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(2)

    // The same working terminals again are not a change.
    set.setRendererEntries(owner(1), [], [asSessionsTerminalHandle('t2')])
    expect(listener).toHaveBeenCalledTimes(2)

    set.removeOwner(2)
    expect(set.snapshot().working).toEqual(['t2'])
    expect(set.snapshot().entries).toEqual([])
    set.clear()
    expect(set.snapshot().working).toEqual([])
  })

  it('carries a prompt body from the renderer and treats a new body as a change', () => {
    const set = new ActionableAttentionSet()
    const prompt = (body: string): ActionableAttentionEntry => ({
      ...rendererEntry('t1', 'prompt'),
      body,
    })
    set.setRendererEntries(owner(1), [prompt('Claude needs your permission')])
    expect(set.snapshot().entries).toEqual([
      {
        key: 't1',
        kind: 'prompt',
        freshness: 'fresh',
        terminalHandle: asSessionsTerminalHandle('t1'),
        body: 'Claude needs your permission',
      },
    ])
    const revision = set.snapshot().revision
    set.setRendererEntries(owner(1), [prompt('Claude needs your permission')])
    expect(set.snapshot().revision).toBe(revision)
    set.setRendererEntries(owner(1), [prompt('Claude is waiting for your input')])
    expect(set.snapshot().revision).toBe(revision + 1)
    expect(set.snapshot().entries[0]?.body).toBe('Claude is waiting for your input')
    set.setRendererEntries(owner(1), [rendererEntry('t1', 'prompt')])
    expect(set.snapshot().entries[0]).not.toHaveProperty('body')
  })

  it('counts fresh entries only and keeps stale ones in the snapshot', () => {
    const set = new ActionableAttentionSet()
    set.setRendererEntries(owner(1), [rendererEntry('t1'), rendererEntry('t2', 'bell')])
    set.setExternal([external('s1'), external('s2', 'stale')])
    expect(set.freshCount()).toBe(3)
    expect(set.snapshot().entries.map((entry) => entry.key)).toEqual([
      'gas-city host-a s1',
      'gas-city host-a s2',
      't1',
      't2',
    ])
    expect(set.snapshot().entries[1]).toMatchObject({
      freshness: 'stale',
      reason: 'unreachable',
      external: { sourceId: 'gas-city', hostId: asHostId('host-a'), key: 's2' },
    })
  })

  it('bumps the revision only when the entries or away change', () => {
    const set = new ActionableAttentionSet()
    const listener = vi.fn()
    set.observe(listener)
    const first = set.snapshot().revision

    set.setRendererEntries(owner(1), [rendererEntry('t1')])
    expect(set.snapshot().revision).toBe(first + 1)
    set.setRendererEntries(owner(1), [rendererEntry('t1')])
    expect(set.snapshot().revision).toBe(first + 1)
    set.setFocused(owner(1), false)
    expect(set.snapshot().revision).toBe(first + 1)
    set.setFocused(owner(1), true)
    expect(set.snapshot().revision).toBe(first + 2)
    set.setExternal([])
    expect(set.snapshot().revision).toBe(first + 2)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(set.snapshot())
  })

  it('stops notifying a disposed observer and forgets everything on clear', () => {
    const set = new ActionableAttentionSet()
    const listener = vi.fn()
    const stop = set.observe(listener)
    set.setFocused(owner(1), true)
    set.setRendererEntries(owner(1), [rendererEntry('t1')])
    stop()
    set.clear()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(set.snapshot()).toMatchObject({ away: true, entries: [] })
    expect(set.freshCount()).toBe(0)
  })

  it('names the entries that appeared between two snapshots', () => {
    const set = new ActionableAttentionSet()
    set.setRendererEntries(owner(1), [rendererEntry('t1')])
    const previous = set.snapshot()
    set.setRendererEntries(owner(1), [rendererEntry('t1', 'bell'), rendererEntry('t2')])
    set.setExternal([external('s1')])
    expect(appearances(previous, set.snapshot()).map((entry) => entry.key)).toEqual([
      'gas-city host-a s1',
      't2',
    ])
    expect(appearances(set.snapshot(), previous).map((entry) => entry.key)).toEqual([])
  })
})
