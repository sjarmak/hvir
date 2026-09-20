import { describe, expect, it } from 'vitest'

import { asHostId, hostPath, type HostId } from '../src/shared'
import type { Disposer } from '../src/main/project-host'
import type {
  CityPendingEntry,
  ListBodyCityPendingEntry,
} from '../src/main/gascity/generated-supervisor-api'
import {
  GasCityEventStreams,
  type CityEventStreamHost,
} from '../src/main/gascity/city-event-streams'
import type {
  SupervisorAccess,
  SupervisorAddressResult,
} from '../src/main/gascity/supervisor-access'
import type {
  GascitySupervisorClient,
  SupervisorCityStreamSubscribers,
  SupervisorResult,
  SupervisorStreamSubscription,
} from '../src/main/gascity/supervisor-client'
import type { SupervisorCityLifecycleEvent } from '../src/main/gascity/supervisor-stream'

const RIG_ONE = asHostId('rig-1')
const RIG_TWO = asHostId('rig-2')

describe('gas city event streams', () => {
  it('opens one stream per host, however many of its projects are open', async () => {
    const world = harness([
      { hostId: RIG_ONE, cityRoot: hostPath(RIG_ONE, '/home/dev/gas-city') },
      { hostId: RIG_ONE },
      { hostId: RIG_TWO },
    ])
    world.streams.start()
    await world.settle()

    expect(world.opened.map((stream) => stream.hostId)).toEqual([RIG_ONE, RIG_TWO])
    // The city root the first entry carried is the one the stream opened with.
    expect(world.opened[0]?.cityRoot?.path).toBe('/home/dev/gas-city')
    expect(
      world.streams.observationSnapshot().map((facts) => [facts.hostId, facts.stream]),
    ).toEqual([
      [RIG_ONE, 'live'],
      [RIG_TWO, 'live'],
    ])
  })

  it('closes the stream and its channel when the host loses its last project', async () => {
    const world = harness([{ hostId: RIG_ONE }, { hostId: RIG_ONE }, { hostId: RIG_TWO }])
    world.streams.start()
    await world.settle()

    // One of two projects on rig-1 closing changes nothing.
    world.setHosts([{ hostId: RIG_ONE }, { hostId: RIG_TWO }])
    await world.settle()
    expect(world.opened.filter((stream) => !stream.closed)).toHaveLength(2)

    world.setHosts([{ hostId: RIG_TWO }])
    await world.settle()
    expect(world.opened.filter((stream) => !stream.closed).map((s) => s.hostId)).toEqual([
      RIG_TWO,
    ])
    expect(world.streams.observationSnapshot().map((facts) => facts.hostId)).toEqual([
      RIG_TWO,
    ])
  })

  it('does not care whether anything is observing', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    const release = world.streams.observe(() => {})
    world.streams.start()
    await world.settle()
    // Sessions closing releases its listener; the stream is not its to end.
    void release()
    await world.settle()

    expect(world.opened.filter((stream) => !stream.closed)).toHaveLength(1)
    expect(world.streams.observationSnapshot()[0]?.stream).toBe('live')
  })

  it('folds a lifecycle event and wakes its listeners', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    let woken = 0
    world.streams.observe(() => {
      woken += 1
    })
    world.streams.start()
    await world.settle()
    const before = woken

    world.opened[0]?.subscribers.onEvent({ kind: 'lifecycle', data: crashed(41, 'gc-1') })
    await world.settle()

    expect(world.streams.observationSnapshot()[0]?.lifecycle).toEqual([
      {
        sessionKey: 'gc-1',
        event: 'session.crashed',
        at: 'ts-41',
        seq: 41,
        reason: 'exit 1',
      },
    ])
    expect(woken).toBeGreaterThan(before)
  })

  it('lets a keep-alive confirm the facts without waking anyone', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.streams.start()
    await world.settle()
    let woken = 0
    world.streams.observe(() => {
      woken += 1
    })

    world.opened[0]?.subscribers.onEvent({
      kind: 'heartbeat',
      data: { timestamp: 'ts-1' },
    })
    world.opened[0]?.subscribers.onEvent({
      kind: 'unrecognized',
      event: 'beads.updated',
      reason: 'Event type is not reported',
    })
    await world.settle()

    expect(woken).toBe(0)
    expect(world.streams.observationSnapshot()[0]?.stream).toBe('live')
  })

  it('marks the facts stale on transport loss, and never reopens by itself', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.streams.start()
    await world.settle()
    world.opened[0]?.subscribers.onEvent({ kind: 'lifecycle', data: crashed(41, 'gc-1') })
    await world.settle()

    world.opened[0]?.subscribers.onClose({ reason: 'unreachable', detail: '' })
    await world.settle()
    // A reconcile does not count as a resumption: the host still has its
    // project open, so nothing here decides to dial again.
    world.setHosts([{ hostId: RIG_ONE }])
    world.pollPending()
    await world.settle()

    const facts = world.streams.observationSnapshot()[0]
    expect(facts).toMatchObject({ stream: 'lost', reason: 'unreachable' })
    // The facts survive the loss; hiding a crashed session would be worse.
    expect(facts?.lifecycle).toHaveLength(1)
    expect(world.opened).toHaveLength(1)
  })

  it('resumes from the sequence it last received, when asked', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.streams.start()
    await world.settle()
    world.opened[0]?.subscribers.onEvent({ kind: 'lifecycle', data: crashed(41, 'gc-1') })
    world.opened[0]?.subscribers.onClose({ reason: 'unreachable', detail: '' })
    await world.settle()

    world.streams.resume(RIG_ONE)
    await world.settle()

    expect(world.opened).toHaveLength(2)
    expect(world.opened[1]?.afterSeq).toBe('41')
    const resumed = world.streams.observationSnapshot()[0]
    expect(resumed?.stream).toBe('live')
    // A stream that is being watched again carries no reason for being stale.
    expect(resumed?.reason).toBeUndefined()
  })

  it('ignores a resume for a stream that is already live', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.streams.start()
    await world.settle()

    world.streams.resume(RIG_ONE)
    world.streams.resume(asHostId('rig-absent'))
    await world.settle()

    expect(world.opened).toHaveLength(1)
  })

  it('reports a host whose city cannot be addressed, with the reason', async () => {
    const world = harness([{ hostId: RIG_ONE }], {
      address: () => ({ ok: false, failure: { reason: 'city-unknown' } }),
    })
    world.streams.start()
    await world.settle()

    expect(world.streams.observationSnapshot()[0]).toMatchObject({
      stream: 'unavailable',
      reason: 'city-unknown',
    })
    expect(world.opened).toHaveLength(0)
  })

  it('reads the declared pending list, and reads it again on the poll', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.pending = [entry('r1', 'gc-1')]
    world.streams.start()
    await world.settle()

    expect(world.streams.observationSnapshot()[0]?.pending).toEqual([
      { sessionKey: 'gc-1', requestId: 'r1', kind: 'approval' },
    ])

    world.pending = [entry('r1', 'gc-1'), entry('r2', 'gc-2')]
    world.pollPending()
    await world.settle()

    expect(world.streams.observationSnapshot()[0]?.pending).toHaveLength(2)
    expect(world.reads).toBe(2)
  })

  it('withdraws an answered interaction without waiting for the next read', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.pending = [entry('r1', 'gc-1'), entry('r2', 'gc-2')]
    world.streams.start()
    await world.settle()

    world.streams.withdrawPending(RIG_ONE, 'r1')

    expect(
      world.streams.observationSnapshot()[0]?.pending.map((held) => held.requestId),
    ).toEqual(['r2'])
    expect(world.reads).toBe(1)
  })

  it('marks the host stale when the pending list can no longer be read', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.pending = [entry('r1', 'gc-1')]
    world.streams.start()
    await world.settle()

    world.pendingFailure = 'timeout'
    world.pollPending()
    await world.settle()

    const facts = world.streams.observationSnapshot()[0]
    // Neither dropped nor asserted: held, with the reason nobody is confirming it.
    expect(facts).toMatchObject({ stream: 'lost', reason: 'timeout' })
    expect(facts?.pending).toHaveLength(1)
    expect(world.opened[0]?.closed).toBe(true)
  })

  it('stops the poll and closes every channel on disposal', async () => {
    const world = harness([{ hostId: RIG_ONE }, { hostId: RIG_TWO }])
    world.streams.start()
    await world.settle()

    world.streams.dispose()
    world.streams.dispose()
    await world.settle()

    expect(world.opened.every((stream) => stream.closed)).toBe(true)
    expect(world.scheduled).toBe(false)
    expect(world.hostsObserved).toBe(false)
    expect(world.streams.observationSnapshot()).toEqual([])
  })

  it('closes a channel that arrived after its host went away', async () => {
    const world = harness([{ hostId: RIG_ONE }])
    world.holdOpen = true
    world.streams.start()
    await world.settle()

    // The last project on the host closes while the channel is still opening.
    world.setHosts([])
    await world.settle()
    world.releaseOpen()
    await world.settle()

    expect(world.opened).toHaveLength(1)
    expect(world.opened[0]?.closed).toBe(true)
    expect(world.streams.observationSnapshot()).toEqual([])
  })
})

interface FakeCityStream {
  readonly hostId: HostId
  readonly cityRoot?: ReturnType<typeof hostPath>
  readonly afterSeq: string | undefined
  readonly subscribers: SupervisorCityStreamSubscribers
  closed: boolean
}

function harness(
  hosts: readonly CityEventStreamHost[],
  overrides: { readonly address?: () => SupervisorAddressResult } = {},
) {
  const opened: FakeCityStream[] = []
  const held: (() => void)[] = []
  let current = [...hosts]
  let hostsListener: (() => void) | undefined
  let tick: (() => void) | undefined

  const world = {
    opened,
    reads: 0,
    pending: [] as readonly CityPendingEntry[],
    pendingFailure: undefined as 'timeout' | undefined,
    scheduled: false,
    hostsObserved: false,
    /** Holds every channel open until it is released, to test late arrivals. */
    holdOpen: false,
    releaseOpen: () => {
      for (const release of held.splice(0)) release()
    },
    streams: undefined as unknown as GasCityEventStreams,
    setHosts: (next: readonly CityEventStreamHost[]) => {
      current = [...next]
      hostsListener?.()
    },
    pollPending: () => tick?.(),
    settle: async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
    },
  }

  const clientFor = (hostId: HostId, cityRoot?: ReturnType<typeof hostPath>) =>
    ({
      streamCity: (
        _city: string,
        subscribers: SupervisorCityStreamSubscribers,
        afterSeq?: string,
      ): Promise<SupervisorStreamSubscription> => {
        const stream: FakeCityStream = {
          hostId,
          ...(cityRoot === undefined ? {} : { cityRoot }),
          afterSeq,
          subscribers,
          closed: false,
        }
        const subscription: SupervisorStreamSubscription = {
          close: () => {
            stream.closed = true
          },
          get cursor() {
            return afterSeq
          },
        }
        opened.push(stream)
        if (!world.holdOpen) return Promise.resolve(subscription)
        return new Promise((resolve) => {
          held.push(() => resolve(subscription))
        })
      },
      cityPending: (): Promise<SupervisorResult<ListBodyCityPendingEntry>> => {
        world.reads += 1
        if (world.pendingFailure !== undefined)
          return Promise.resolve({
            ok: false,
            failure: { reason: world.pendingFailure, detail: '' },
          })
        return Promise.resolve({
          ok: true,
          value: { items: world.pending, total: world.pending.length },
        })
      },
    }) as unknown as GascitySupervisorClient

  const access: SupervisorAccess = {
    address: (target) =>
      Promise.resolve(
        overrides.address?.() ?? {
          ok: true,
          value: {
            client: clientFor(target.hostId, target.cityRoot),
            cityName: `city-${target.hostId}`,
          },
        },
      ),
  }

  world.streams = new GasCityEventStreams({
    access,
    hosts: () => current,
    observeHosts: (listener): Disposer => {
      hostsListener = listener
      world.hostsObserved = true
      return () => {
        hostsListener = undefined
        world.hostsObserved = false
      }
    },
    now: () => 1_000,
    schedule: (poll): Disposer => {
      tick = poll
      world.scheduled = true
      return () => {
        tick = undefined
        world.scheduled = false
      }
    },
  })
  return world
}

function crashed(seq: number, sessionId: string): SupervisorCityLifecycleEvent {
  return {
    seq,
    type: 'session.crashed',
    ts: `ts-${seq}`,
    actor: 'gc',
    session_id: sessionId,
    payload: { session_id: sessionId, reason: 'exit 1' },
  }
}

function entry(requestId: string, sessionId: string): CityPendingEntry {
  return { kind: 'approval', request_id: requestId, session_id: sessionId }
}
