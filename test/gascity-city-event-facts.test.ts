import { describe, expect, it } from 'vitest'

import { asHostId, hostPath } from '../src/shared'
import type { CityPendingEntry } from '../src/main/gascity/generated-supervisor-api'
import {
  MAX_CITY_LIFECYCLE_FACTS,
  MAX_CITY_PENDING_FACTS,
  foldCityLifecycleEvent,
  foldCityPending,
  hostCityEventsFresh,
  liveHostCityEvents,
  lostHostCityEvents,
  openingHostCityEvents,
  unavailableHostCityEvents,
  withdrawCityPending,
  type HostCityEvents,
} from '../src/main/gascity/city-event-facts'
import type { SupervisorCityLifecycleEvent } from '../src/main/gascity/supervisor-stream'

const HOST = asHostId('rig-1')
const CITY_ROOT = hostPath(HOST, '/home/dev/gas-city')

describe('host city event facts', () => {
  it('opens stale, with the city root it was opened against', () => {
    const opened = openingHostCityEvents(HOST, CITY_ROOT, 10)

    expect(opened).toEqual({
      hostId: HOST,
      cityRoot: CITY_ROOT,
      stream: 'opening',
      observedAt: 10,
      lifecycle: [],
      pending: [],
    })
    // Nothing is claimed as current until the stream is actually watching.
    expect(hostCityEventsFresh(opened)).toBe(false)
  })

  it('folds a crash into the session it names, with the reason verbatim', () => {
    const folded = foldCityLifecycleEvent(
      opened(),
      crashed(41, 'gc-1', 'exit 1'),
      '41',
      20,
    )

    expect(folded.lifecycle).toEqual([
      {
        sessionKey: 'gc-1',
        event: 'session.crashed',
        at: 'ts-41',
        seq: 41,
        reason: 'exit 1',
      },
    ])
    expect(folded.cursor).toBe('41')
    expect(hostCityEventsFresh(folded)).toBe(true)
  })

  it('keeps one transition per session, the latest', () => {
    const crash = foldCityLifecycleEvent(
      opened(),
      crashed(41, 'gc-1', 'exit 1'),
      '41',
      20,
    )
    const woke = foldCityLifecycleEvent(
      crash,
      lifecycle(42, 'session.woke', 'gc-1'),
      '42',
      21,
    )

    expect(woke.lifecycle).toEqual([
      { sessionKey: 'gc-1', event: 'session.woke', at: 'ts-42', seq: 42 },
    ])
  })

  it('does not let a late arrival overwrite a later transition', () => {
    const woke = foldCityLifecycleEvent(
      opened(),
      lifecycle(42, 'session.woke', 'gc-1'),
      '42',
      20,
    )
    const late = foldCityLifecycleEvent(woke, crashed(40, 'gc-1', 'exit 1'), '43', 21)

    expect(late.lifecycle.map((fact) => fact.event)).toEqual(['session.woke'])
    // The cursor still advances: the event was received, just not applied.
    expect(late.cursor).toBe('43')
  })

  it('holds each session separately, newest first', () => {
    const one = foldCityLifecycleEvent(
      opened(),
      lifecycle(1, 'session.stopped', 'gc-1'),
      '1',
      20,
    )
    const two = foldCityLifecycleEvent(
      one,
      lifecycle(2, 'session.quarantined', 'gc-2'),
      '2',
      21,
    )

    expect(two.lifecycle.map((fact) => fact.sessionKey)).toEqual(['gc-2', 'gc-1'])
  })

  it('drops an event that names no session rather than guessing one', () => {
    const anonymous = foldCityLifecycleEvent(
      opened(),
      { seq: 5, type: 'session.woke', ts: 'ts-5', actor: 'gc', payload: {} },
      '5',
      20,
    )

    expect(anonymous.lifecycle).toEqual([])
    expect(anonymous.cursor).toBe('5')
  })

  it('reads the session and reason out of a lifecycle payload', () => {
    const payloadOnly = foldCityLifecycleEvent(
      opened(),
      {
        seq: 6,
        type: 'session.stopped',
        ts: 'ts-6',
        actor: 'gc',
        payload: { session_id: 'gc-9', reason: 'operator stop' },
      },
      '6',
      20,
    )

    expect(payloadOnly.lifecycle[0]).toMatchObject({
      sessionKey: 'gc-9',
      reason: 'operator stop',
    })
  })

  it('caps a reason instead of holding a payload', () => {
    const long = foldCityLifecycleEvent(
      opened(),
      crashed(7, 'gc-1', 'x'.repeat(400)),
      '7',
      20,
    )

    expect(long.lifecycle[0]?.reason).toHaveLength(201)
    expect(long.lifecycle[0]?.reason?.endsWith('…')).toBe(true)
  })

  it('holds the newest transitions at the cap', () => {
    let facts = opened()
    for (let index = 0; index < MAX_CITY_LIFECYCLE_FACTS + 6; index += 1) {
      facts = foldCityLifecycleEvent(
        facts,
        lifecycle(index + 1, 'session.suspended', `gc-${index}`),
        String(index + 1),
        20,
      )
    }

    expect(facts.lifecycle).toHaveLength(MAX_CITY_LIFECYCLE_FACTS)
    expect(facts.lifecycle[0]?.sessionKey).toBe(`gc-${MAX_CITY_LIFECYCLE_FACTS + 5}`)
  })

  it('replaces the pending list wholesale, because the read is the answer', () => {
    const two = foldCityPending(
      opened(),
      [pending('r1', 'gc-1'), pending('r2', 'gc-2')],
      20,
    )
    const one = foldCityPending(two, [pending('r2', 'gc-2')], 21)

    expect(two.pending).toEqual([
      { sessionKey: 'gc-1', requestId: 'r1', kind: 'approval' },
      { sessionKey: 'gc-2', requestId: 'r2', kind: 'approval' },
    ])
    // An interaction absent from the supervisor's own list was resolved.
    expect(one.pending.map((entry) => entry.requestId)).toEqual(['r2'])
  })

  it('caps the pending list too', () => {
    const many = Array.from({ length: MAX_CITY_PENDING_FACTS + 4 }, (_, index) =>
      pending(`r${index}`, `gc-${index}`),
    )

    expect(foldCityPending(opened(), many, 20).pending).toHaveLength(
      MAX_CITY_PENDING_FACTS,
    )
  })

  it('withdraws an answered interaction without waiting for a read', () => {
    const held = foldCityPending(
      opened(),
      [pending('r1', 'gc-1'), pending('r2', 'gc-2')],
      20,
    )
    const answered = withdrawCityPending(held, 'r1')

    expect(answered.pending.map((entry) => entry.requestId)).toEqual(['r2'])
    expect(answered.stream).toBe('live')
  })

  it('keeps the facts when the stream is lost, and says why', () => {
    const live = foldCityPending(
      foldCityLifecycleEvent(opened(), crashed(41, 'gc-1', 'exit 1'), '41', 20),
      [pending('r1', 'gc-1')],
      21,
    )
    const lost = lostHostCityEvents(live, 'closed')

    expect(lost.lifecycle).toEqual(live.lifecycle)
    expect(lost.pending).toEqual(live.pending)
    expect(lost.cursor).toBe('41')
    expect(lost.stream).toBe('lost')
    expect(lost.reason).toBe('closed')
    expect(hostCityEventsFresh(lost)).toBe(false)
  })

  it('separates a stream that never opened from one that stopped', () => {
    const never = unavailableHostCityEvents(opened(), 'city-unknown')

    expect(never).toMatchObject({ stream: 'unavailable', reason: 'city-unknown' })
  })

  it('drops the reason when a stream comes back, not before', () => {
    const lost = lostHostCityEvents(opened(), 'timeout')

    expect(liveHostCityEvents(lost, 30)).toEqual({
      hostId: HOST,
      cityRoot: CITY_ROOT,
      stream: 'live',
      observedAt: 30,
      lifecycle: [],
      pending: [],
    })
  })
})

function opened(): HostCityEvents {
  return openingHostCityEvents(HOST, CITY_ROOT, 10)
}

function lifecycle(
  seq: number,
  type: SupervisorCityLifecycleEvent['type'],
  sessionId: string,
): SupervisorCityLifecycleEvent {
  return {
    seq,
    type,
    ts: `ts-${seq}`,
    actor: 'gc',
    session_id: sessionId,
    payload: {},
  } as SupervisorCityLifecycleEvent
}

function crashed(
  seq: number,
  sessionId: string,
  reason: string,
): SupervisorCityLifecycleEvent {
  return {
    seq,
    type: 'session.crashed',
    ts: `ts-${seq}`,
    actor: 'gc',
    session_id: sessionId,
    payload: { session_id: sessionId, reason },
  }
}

function pending(requestId: string, sessionId: string): CityPendingEntry {
  return { kind: 'approval', request_id: requestId, session_id: sessionId }
}
