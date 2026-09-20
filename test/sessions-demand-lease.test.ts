import { describe, expect, it, vi } from 'vitest'

import {
  SessionsDemandLeases,
  SessionsSourceObservation,
  queueLeaseNotification,
} from '../src/main/sessions/sessions-demand-lease'
import { rendererDemandOwner } from '../src/main/sessions/sessions-demand-owner'
import type { SessionsDemandOwner } from '../src/main/sessions/sessions-demand-owner'

interface TestLease {
  readonly owner: SessionsDemandOwner
  readonly demandGeneration: number
  readonly label: string
  notifyQueued: boolean
}

const renderer = rendererDemandOwner({ id: 7, generation: 4 })
const companion: SessionsDemandOwner = {
  kind: 'companion',
  page: 'page-93',
  generation: 2,
}

function lease(
  owner: SessionsDemandOwner,
  demandGeneration: number,
  label: string,
): TestLease {
  return { owner, demandGeneration, label, notifyQueued: false }
}

describe('SessionsDemandLeases', () => {
  it('answers for the generation asked for and refuses every other', () => {
    const leases = new SessionsDemandLeases<TestLease>()
    leases.add(lease(renderer, 5, 'live'))

    expect(leases.at(renderer, 5)?.label).toBe('live')
    expect(leases.at(renderer, 6)).toBeUndefined()
    expect(leases.at(renderer, 4)).toBeUndefined()
    expect(leases.require(renderer, 5, 'gone').label).toBe('live')
    expect(() => leases.require(renderer, 6, 'the lease moved on')).toThrow(
      'the lease moved on',
    )
    expect(() => leases.require(companion, 5, 'no companion lease')).toThrow(
      'no companion lease',
    )
  })

  it('keeps a renderer and a companion apart at the same generation', () => {
    const leases = new SessionsDemandLeases<TestLease>()
    leases.add(lease(renderer, 3, 'desk'))
    leases.add(lease(companion, 3, 'phone'))

    expect(leases.size).toBe(2)
    expect(leases.at(renderer, 3)?.label).toBe('desk')
    expect(leases.at(companion, 3)?.label).toBe('phone')
    expect(leases.remove(companion, 3)?.label).toBe('phone')
    expect(leases.at(renderer, 3)?.label).toBe('desk')
  })

  it('hands a removed lease back and leaves a stale release holding nothing', () => {
    const leases = new SessionsDemandLeases<TestLease>()
    const held = lease(renderer, 8, 'held')
    leases.add(held)

    expect(leases.remove(renderer, 7)).toBeUndefined()
    expect(leases.size).toBe(1)
    expect(leases.remove(renderer, 8)).toBe(held)
    expect(leases.size).toBe(0)
    expect(leases.remove(renderer, 8)).toBeUndefined()
  })

  it('owns only this exact lease, and nothing once disposed', () => {
    const leases = new SessionsDemandLeases<TestLease>()
    const first = lease(renderer, 2, 'first')
    leases.add(first)
    expect(leases.owns(first)).toBe(true)

    // A reacquire at a new generation replaces the lease for the same owner, so
    // a callback still holding the old one must not write through it.
    const second = lease(renderer, 3, 'second')
    leases.add(second)
    expect(leases.owns(first)).toBe(false)
    expect(leases.owns(second)).toBe(true)

    leases.dispose()
    expect(leases.owns(second)).toBe(false)
  })

  it('hands every held lease back once, so teardown runs once', () => {
    const leases = new SessionsDemandLeases<TestLease>()
    const desk = lease(renderer, 6, 'desk')
    const phone = lease(companion, 9, 'phone')
    leases.add(desk)
    leases.add(phone)

    expect(leases.disposed).toBe(false)
    expect([...leases.dispose()]).toEqual([desk, phone])
    expect(leases.disposed).toBe(true)
    expect(leases.size).toBe(0)
    expect([...leases.dispose()]).toEqual([])
  })

  it('walks a snapshot, so a lease released mid-walk does not disturb it', () => {
    const leases = new SessionsDemandLeases<TestLease>()
    leases.add(lease(renderer, 1, 'desk'))
    leases.add(lease(companion, 1, 'phone'))

    const seen: string[] = []
    for (const held of leases.all()) {
      seen.push(held.label)
      leases.remove(held.owner, held.demandGeneration)
    }
    expect(seen).toEqual(['desk', 'phone'])
    expect(leases.size).toBe(0)
  })
})

describe('SessionsSourceObservation', () => {
  it('opens one subscription however many leases ask', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    const source = new SessionsSourceObservation(observe)

    source.start()
    source.start()
    source.start()
    expect(observe).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  it('holds the subscription open while a lease is left and closes it on the last', () => {
    const stop = vi.fn()
    const source = new SessionsSourceObservation(() => stop)
    source.start()

    source.stopIfIdle({ size: 2 })
    expect(stop).not.toHaveBeenCalled()
    source.stopIfIdle({ size: 1 })
    expect(stop).not.toHaveBeenCalled()

    source.stopIfIdle({ size: 0 })
    expect(stop).toHaveBeenCalledTimes(1)

    // Closed once: an idle check after the last lease has nothing left to close.
    source.stopIfIdle({ size: 0 })
    source.stop()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('opens again after a close, so a port that goes idle can be used again', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    const source = new SessionsSourceObservation(observe)

    source.start()
    source.stopIfIdle({ size: 0 })
    source.start()
    expect(observe).toHaveBeenCalledTimes(2)
  })
})

describe('queueLeaseNotification', () => {
  it('emits once for everything that moved in one microtask', async () => {
    const held = lease(renderer, 3, 'held')
    const emit = vi.fn()

    queueLeaseNotification(held, emit)
    queueLeaseNotification(held, emit)
    queueLeaseNotification(held, emit)
    expect(held.notifyQueued).toBe(true)
    expect(emit).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(held.notifyQueued).toBe(false)
  })

  it('queues the next notification for a change the emit itself makes', async () => {
    const held = lease(renderer, 3, 'held')
    const emitted: number[] = []
    const emit = (): void => {
      emitted.push(emitted.length + 1)
      if (emitted.length === 1) queueLeaseNotification(held, emit)
    }

    queueLeaseNotification(held, emit)
    await Promise.resolve()
    await Promise.resolve()

    expect(emitted).toEqual([1, 2])
  })
})
