import { describe, expect, it, vi } from 'vitest'

import type {
  ActionableSnapshot,
  MainActionableEntry,
} from '../src/main/attention/actionable-attention-set'
import { AwayPush, type AwayPushOutcome } from '../src/main/companion/away-push'
import type { PushMessage, PushOutcome, PushSink } from '../src/main/companion/push-sink'
import { asHostId, asSessionsTerminalHandle } from '../src/shared'

function terminal(
  id: string,
  extra: Partial<MainActionableEntry> = {},
): MainActionableEntry {
  return {
    key: id,
    kind: 'ready',
    freshness: 'fresh',
    terminalHandle: asSessionsTerminalHandle(id),
    ...extra,
  }
}

function external(
  key: string,
  extra: Partial<MainActionableEntry> = {},
): MainActionableEntry {
  return {
    key: `gas-city rig-1 ${key}`,
    kind: 'ready',
    freshness: 'fresh',
    external: { sourceId: 'gas-city', hostId: asHostId('rig-1'), key },
    ...extra,
  }
}

interface FakeSet {
  snapshot(): ActionableSnapshot
  observe(listener: (snapshot: ActionableSnapshot) => void): () => void
  emit(away: boolean, entries: readonly MainActionableEntry[]): void
  readonly listeners: number
}

function fakeSet(initial: {
  away: boolean
  entries?: readonly MainActionableEntry[]
}): FakeSet {
  const listeners = new Set<(snapshot: ActionableSnapshot) => void>()
  let current: ActionableSnapshot = {
    revision: 1,
    away: initial.away,
    entries: initial.entries ?? [],
    working: [],
  }
  return {
    snapshot: () => current,
    observe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: (away, entries) => {
      current = { revision: current.revision + 1, away, entries, working: [] }
      for (const listener of listeners) listener(current)
    },
    get listeners() {
      return listeners.size
    },
  }
}

interface World {
  readonly set: FakeSet
  readonly push: AwayPush
  readonly sent: PushMessage[]
  readonly described: MainActionableEntry[]
  readonly outcomes: AwayPushOutcome[]
  settle(): Promise<void>
}

function harness(
  options: {
    away?: boolean
    initial?: readonly MainActionableEntry[]
    sink?: () => PushSink | undefined
    describe?: (entry: MainActionableEntry) => Promise<PushMessage | undefined>
    send?: (message: PushMessage) => Promise<PushOutcome>
  } = {},
): World {
  const sent: PushMessage[] = []
  const described: MainActionableEntry[] = []
  const outcomes: AwayPushOutcome[] = []
  const set = fakeSet({ away: options.away ?? true, entries: options.initial ?? [] })
  const sink: PushSink = {
    send: (message) => {
      sent.push(message)
      return options.send?.(message) ?? Promise.resolve({ outcome: 'sent' })
    },
  }
  const push = new AwayPush({
    set,
    sink: options.sink ?? (() => sink),
    describe:
      options.describe ??
      ((entry) => {
        described.push(entry)
        return Promise.resolve({ project: 'hvir', title: entry.key, kind: entry.kind })
      }),
    onOutcome: (outcome) => outcomes.push(outcome),
  })
  return {
    set,
    push,
    sent,
    described,
    outcomes,
    settle: async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    },
  }
}

describe('AwayPush', () => {
  it('sends once for an entry that appears while away', async () => {
    const world = harness()
    world.set.emit(true, [terminal('t-1')])
    await world.settle()

    expect(world.sent).toEqual([{ project: 'hvir', title: 't-1', kind: 'ready' }])
    expect(world.outcomes).toEqual([
      { source: 'terminal', kind: 'ready', result: { outcome: 'sent' } },
    ])
  })

  it('does not send again while the same entry persists across snapshots', async () => {
    const world = harness()
    world.set.emit(true, [terminal('t-1')])
    world.set.emit(true, [terminal('t-1'), terminal('t-2')])
    world.set.emit(true, [terminal('t-1'), terminal('t-2')])
    await world.settle()

    expect(world.sent.map((message) => message.title)).toEqual(['t-1', 't-2'])
  })

  it('sends nothing when an entry leaves, and once more when it re-enters', async () => {
    const world = harness()
    world.set.emit(true, [terminal('t-1')])
    world.set.emit(true, [])
    await world.settle()
    expect(world.sent).toHaveLength(1)

    world.set.emit(true, [terminal('t-1')])
    await world.settle()
    expect(world.sent).toHaveLength(2)
  })

  it('never sends for an entry that appeared at the desk, even after a later blur', async () => {
    const world = harness({ away: false })
    world.set.emit(false, [terminal('t-1')])
    world.set.emit(true, [terminal('t-1')])
    await world.settle()

    expect(world.sent).toEqual([])
    expect(world.described).toEqual([])
  })

  it('treats the set at construction as a baseline, not an appearance', async () => {
    const world = harness({ away: true, initial: [external('w-1')] })
    world.set.emit(true, [external('w-1'), external('w-2')])
    await world.settle()

    expect(world.sent.map((message) => message.title)).toEqual(['gas-city rig-1 w-2'])
  })

  it('sends for an external entry when no window exists at all', async () => {
    const world = harness({ away: true })
    world.set.emit(true, [external('w-1')])
    await world.settle()

    expect(world.sent).toHaveLength(1)
    expect(world.sent[0]?.kind).toBe('ready')
  })

  it('skips a stale entry, and does not push it later when it is confirmed', async () => {
    const world = harness()
    world.set.emit(true, [external('w-1', { freshness: 'stale', reason: 'unreachable' })])
    await world.settle()
    expect(world.sent).toEqual([])
    expect(world.described).toEqual([])

    world.set.emit(true, [external('w-1')])
    await world.settle()
    expect(world.sent).toEqual([])
  })

  it('sends nothing when the entry cannot be described', async () => {
    const world = harness({ describe: () => Promise.resolve(undefined) })
    world.set.emit(true, [terminal('t-1')])
    await world.settle()

    expect(world.sent).toEqual([])
    expect(world.outcomes).toEqual([
      {
        source: 'terminal',
        kind: 'ready',
        result: { outcome: 'skipped', reason: 'not-described' },
      },
    ])
  })

  it('reports a missing sink and a sink failure once each, with no retry', async () => {
    let configured = false
    const sendCalls = vi.fn<PushSink['send']>(() =>
      Promise.resolve({ outcome: 'failed', reason: 'unreachable' }),
    )
    const world = harness({
      sink: () => (configured ? { send: sendCalls } : undefined),
    })
    world.set.emit(true, [terminal('t-1')])
    await world.settle()
    expect(world.outcomes).toEqual([
      {
        source: 'terminal',
        kind: 'ready',
        result: { outcome: 'skipped', reason: 'no-sink' },
      },
    ])

    configured = true
    world.set.emit(true, [terminal('t-1'), terminal('t-2', { kind: 'bell' })])
    await world.settle()
    expect(sendCalls).toHaveBeenCalledTimes(1)
    expect(world.outcomes[1]).toEqual({
      source: 'terminal',
      kind: 'bell',
      result: { outcome: 'failed', reason: 'unreachable' },
    })
    await world.settle()
    expect(sendCalls).toHaveBeenCalledTimes(1)
  })

  it('reports a describer that throws instead of dropping the appearance silently', async () => {
    const world = harness({ describe: () => Promise.reject(new Error('registry gone')) })
    world.set.emit(true, [terminal('t-1')])
    await world.settle()

    expect(world.sent).toEqual([])
    expect(world.outcomes).toEqual([
      {
        source: 'terminal',
        kind: 'ready',
        result: { outcome: 'errored', message: 'registry gone' },
      },
    ])
  })

  it('names an external appearance by source only, never by its foreign key', async () => {
    const world = harness({ sink: () => undefined })
    world.set.emit(true, [external('gc-7')])
    await world.settle()

    expect(world.outcomes).toEqual([
      {
        source: 'external',
        kind: 'ready',
        result: { outcome: 'skipped', reason: 'no-sink' },
      },
    ])
    expect(JSON.stringify(world.outcomes)).not.toContain('gc-7')
  })

  it('stops observing on dispose', async () => {
    const world = harness()
    expect(world.set.listeners).toBe(1)

    world.push.dispose()
    world.set.emit(true, [terminal('t-1')])
    await world.settle()

    expect(world.set.listeners).toBe(0)
    expect(world.sent).toEqual([])
  })
})
