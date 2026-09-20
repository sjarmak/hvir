import { describe, expect, it, vi } from 'vitest'

import { installApplicationAttention } from '../src/main/attention/attention-owner'
import type { ExternalPendingSession } from '../src/main/gascity/city-attention'
import { asHostId, asSessionsTerminalHandle, hostPath } from '../src/shared'

const RIG = asHostId('rig-1')

function pendingSession(
  sessionKey: string,
  extra: Partial<ExternalPendingSession> = {},
): ExternalPendingSession {
  return {
    hostId: RIG,
    sessionKey,
    cityRoot: hostPath(RIG, '/home/dev/gas-city'),
    workspaceId: 'ws-1',
    kind: 'approval',
    freshness: 'fresh',
    title: `Session ${sessionKey}`,
    ...extra,
  }
}

function harness(platform: NodeJS.Platform = 'linux') {
  const owned: { label: string; dispose: () => void | Promise<void> }[] = []
  const runtime = {
    own: <T>(
      label: string,
      resource: T,
      dispose: (resource: T) => void | Promise<void>,
    ) => {
      owned.push({ label, dispose: () => dispose(resource) })
      return resource
    },
  }
  const listeners = new Set<() => void>()
  let pending: readonly ExternalPendingSession[] = []
  const gasCityAttention = {
    pendingSessions: () => pending,
    observePending: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const setBadgeCount = vi.fn<(count: number) => boolean>(() => true)
  return {
    runtime,
    gasCityAttention,
    setBadgeCount,
    counts: () => setBadgeCount.mock.calls.map(([count]) => count),
    labels: () => owned.map((entry) => entry.label),
    listeners,
    publish: (next: readonly ExternalPendingSession[]) => {
      pending = next
      for (const listener of listeners) listener()
    },
    disposeAll: async () => {
      for (const entry of [...owned].reverse()) await entry.dispose()
    },
    install: () =>
      installApplicationAttention(runtime, { gasCityAttention, setBadgeCount, platform }),
  }
}

describe('installApplicationAttention', () => {
  it('picks up a pending interaction published before it was installed', () => {
    const world = harness()
    world.publish([pendingSession('w-1')])

    const attention = world.install()

    expect(attention.set.snapshot().entries).toEqual([
      {
        key: 'gas-city rig-1 w-1',
        kind: 'ready',
        freshness: 'fresh',
        external: { sourceId: 'gas-city', hostId: RIG, key: 'w-1' },
      },
    ])
    // No window exists yet, so hvir is away and the badge counts it (R6).
    expect(world.counts().at(-1)).toBe(1)
  })

  it('follows later pending publications, carrying staleness and its reason', () => {
    const world = harness()
    const attention = world.install()
    expect(world.counts()).toEqual([0])

    world.publish([pendingSession('w-1'), pendingSession('w-2')])
    expect(world.counts().at(-1)).toBe(2)

    world.publish([pendingSession('w-1', { freshness: 'stale', reason: 'unreachable' })])
    expect(attention.set.snapshot().entries).toMatchObject([
      { key: 'gas-city rig-1 w-1', freshness: 'stale', reason: 'unreachable' },
    ])
    expect(world.counts().at(-1)).toBe(0)
  })

  it('routes renderer sets, focus and owner removal into the aggregate', () => {
    const world = harness()
    const attention = world.install()
    const owner = { id: 7, generation: 2 }

    attention.setOwnerFocused(owner, true)
    attention.updateAttention(owner, {
      version: 1,
      entries: [
        { handle: asSessionsTerminalHandle('t1'), kind: 'ready', freshness: 'fresh' },
        { handle: asSessionsTerminalHandle('t2'), kind: 'bell', freshness: 'fresh' },
      ],
      working: [asSessionsTerminalHandle('t3')],
    })
    expect(attention.set.snapshot().working).toEqual(['t3'])
    expect(attention.set.away()).toBe(false)
    expect(world.counts().at(-1)).toBe(0)

    attention.setOwnerFocused(owner, false)
    expect(world.counts().at(-1)).toBe(2)

    attention.removeOwner(owner)
    expect(attention.set.snapshot().entries).toEqual([])
    expect(world.counts().at(-1)).toBe(0)
  })

  it('owns the aggregate before the badge and clears both on disposal', async () => {
    const world = harness()
    const attention = world.install()
    expect(world.labels().indexOf('actionable attention set')).toBeLessThan(
      world.labels().indexOf('attention badge'),
    )
    world.publish([pendingSession('w-1')])
    expect(world.counts().at(-1)).toBe(1)

    await world.disposeAll()

    expect(world.counts().at(-1)).toBe(0)
    expect(world.listeners.size).toBe(0)
    expect(attention.set.snapshot().entries).toEqual([])
    world.publish([pendingSession('w-2')])
    expect(attention.set.snapshot().entries).toEqual([])
  })

  it('never asks a desktop without a badge to draw one', () => {
    const world = harness('win32')
    world.install()
    world.publish([pendingSession('w-1')])
    expect(world.setBadgeCount).not.toHaveBeenCalled()
  })
})
