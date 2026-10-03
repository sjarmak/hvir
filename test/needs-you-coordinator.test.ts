import { describe, expect, it, vi } from 'vitest'
import { NeedsYouCoordinator } from '../src/renderer/src/needs-you/needs-you-coordinator'
import type { NeedsYouSnapshot } from '../src/shared'

const snapshot = (demandGeneration: number): NeedsYouSnapshot => ({
  version: 1,
  demandGeneration,
  revision: 1,
  observedAt: 1,
  sources: [],
})

describe('Needs you renderer demand', () => {
  it('reacquires after a failed initial read instead of refreshing a released lease', async () => {
    const observe = vi.fn((generation: number) => Promise.resolve(snapshot(generation)))
    observe.mockRejectedValueOnce(new Error('Initial read failed'))
    const refresh = vi.fn((generation: number) => Promise.resolve(snapshot(generation)))
    const coordinator = new NeedsYouCoordinator(
      { observe, refresh, release: () => Promise.resolve() },
      vi.fn(),
    )
    const stop = coordinator.acquire()
    await Promise.resolve()
    coordinator.refresh()
    await Promise.resolve()
    expect(observe).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
    expect(coordinator.snapshot().status).toBe('available')
    stop()
  })

  it('invalidates delivered rows on topology change and removes its subscription on release', async () => {
    let changed!: () => void
    const unsubscribe = vi.fn()
    const observe = vi.fn((generation: number) => Promise.resolve(snapshot(generation)))
    const coordinator = new NeedsYouCoordinator(
      {
        observe,
        refresh: observe,
        release: () => Promise.resolve(),
        subscribe: (listener) => {
          changed = listener
          return unsubscribe
        },
      },
      vi.fn(),
    )
    const stop = coordinator.acquire()
    await Promise.resolve()
    changed()
    expect(coordinator.snapshot().status).toBe('unavailable')
    expect(observe).toHaveBeenCalledTimes(1)
    coordinator.refresh()
    await Promise.resolve()
    expect(coordinator.snapshot().status).toBe('available')
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('releases pending demand and rejects its late completion after reopen', async () => {
    let complete!: (result: NeedsYouSnapshot) => void
    const observe = vi.fn((generation: number) =>
      observe.mock.calls.length === 1
        ? new Promise<NeedsYouSnapshot>((resolve) => {
            complete = resolve
          })
        : Promise.resolve(snapshot(generation)),
    )
    const release = vi.fn(() => Promise.resolve())
    const coordinator = new NeedsYouCoordinator(
      { observe, refresh: observe, release },
      vi.fn(),
    )
    const stop = coordinator.acquire()
    expect(coordinator.snapshot().status).toBe('pending')
    stop()
    const firstGeneration = observe.mock.calls[0]![0]
    expect(release).toHaveBeenCalledWith(firstGeneration)
    const nextStop = coordinator.acquire()
    await Promise.resolve()
    const current = coordinator.snapshot()
    complete(snapshot(firstGeneration))
    await Promise.resolve()
    expect(coordinator.snapshot()).toBe(current)
    expect(current.status).toBe('available')
    nextStop()
    expect(coordinator.snapshot().status).toBe('inactive')
  })

  it('makes failed refresh unavailable instead of retaining actionable stale rows', async () => {
    const refresh = vi.fn(() => Promise.reject(new Error('Host disconnected')))
    const coordinator = new NeedsYouCoordinator(
      {
        observe: (generation) => Promise.resolve(snapshot(generation)),
        refresh,
        release: () => Promise.resolve(),
      },
      vi.fn(),
    )
    const stop = coordinator.acquire()
    await Promise.resolve()
    expect(coordinator.snapshot().status).toBe('available')
    coordinator.refresh()
    expect(coordinator.snapshot().status).toBe('pending')
    await Promise.resolve()
    expect(coordinator.snapshot()).toEqual({
      status: 'unavailable',
      message: 'Host disconnected',
    })
    stop()
  })

  it('coalesces refresh demand and reports release failures', async () => {
    const report = vi.fn()
    const observe = vi.fn((generation: number) => Promise.resolve(snapshot(generation)))
    const coordinator = new NeedsYouCoordinator(
      {
        observe,
        refresh: observe,
        release: () => Promise.reject(new Error('Release failed')),
      },
      report,
    )
    const first = coordinator.acquire()
    const second = coordinator.acquire()
    coordinator.refresh()
    expect(observe).toHaveBeenCalledTimes(1)
    first()
    expect(coordinator.snapshot().status).toBe('pending')
    second()
    await Promise.resolve()
    expect(report).toHaveBeenCalledWith('Release failed')
  })

  it('clears delivered results on candidate invalidation and ignores an older in-flight response', async () => {
    let invalidate!: () => void
    let complete!: (value: NeedsYouSnapshot) => void
    let generation = 0
    const coordinator = new NeedsYouCoordinator(
      {
        observe: (value) => {
          generation = value
          return Promise.resolve(snapshot(value))
        },
        refresh: () =>
          new Promise((resolve) => {
            complete = resolve
          }),
        release: () => Promise.resolve(),
        subscribe: (listener) => {
          invalidate = listener
          return () => undefined
        },
      },
      vi.fn(),
    )
    const stop = coordinator.acquire()
    await Promise.resolve()
    coordinator.refresh()
    invalidate()
    expect(coordinator.snapshot().status).toBe('pending')
    complete(snapshot(generation))
    await Promise.resolve()
    expect(coordinator.snapshot().status).toBe('unavailable')
    stop()
  })

  it('reacquires after initial observe fails', async () => {
    const observe = vi
      .fn((generation: number) => Promise.resolve(snapshot(generation)))
      .mockRejectedValueOnce(new Error('Candidate changed'))
    const refresh = vi.fn()
    const coordinator = new NeedsYouCoordinator(
      { observe, refresh, release: () => Promise.resolve() },
      vi.fn(),
    )
    const stop = coordinator.acquire()
    await Promise.resolve()
    coordinator.refresh()
    await Promise.resolve()
    expect(observe).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
    expect(coordinator.snapshot().status).toBe('available')
    stop()
  })
})
