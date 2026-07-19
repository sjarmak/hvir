import { describe, expect, it, vi } from 'vitest'

import { createVisibilityRefresh } from '../src/renderer/src/beads/beads-refresh'

interface Harness {
  readonly onRefresh: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly controller: ReturnType<typeof createVisibilityRefresh>
  /** Delays the controller asked for, in order. */
  readonly delays: number[]
  /** Run the pending scheduled poll, then settle its refresh. */
  tick(): Promise<void>
  /** Let a pending refresh settle so the controller can schedule the next poll. */
  settle(): Promise<void>
  /** How long the next refresh takes on the fake clock. */
  costMs: number
}

/** Drives the controller with injected timers and clock; no real time passes. */
function harness(intervalMs = 5000, options: { costFactor?: number; maxIntervalMs?: number } = {}): Harness {
  let clock = 0
  let scheduled: (() => void) | undefined
  const delays: number[] = []
  const state = { costMs: 0 }
  const onRefresh = vi.fn(() => {
    clock += state.costMs
    return Promise.resolve()
  })
  const cancel = vi.fn()
  const controller = createVisibilityRefresh({
    onRefresh,
    intervalMs,
    ...options,
    schedule: (cb, ms) => {
      scheduled = cb
      delays.push(ms)
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    cancel,
    now: () => clock,
  })
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    onRefresh,
    cancel,
    controller,
    delays,
    settle,
    async tick() {
      scheduled?.()
      await settle()
    },
    get costMs() {
      return state.costMs
    },
    set costMs(value: number) {
      state.costMs = value
    },
  }
}

describe('createVisibilityRefresh', () => {
  it('refreshes immediately on becoming visible and then polls', async () => {
    const h = harness()
    h.controller.setVisible(true)
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
    await h.settle()
    await h.tick()
    await h.tick()
    expect(h.onRefresh).toHaveBeenCalledTimes(3)
  })

  it('is idempotent: re-showing does not double-refresh', async () => {
    const h = harness()
    h.controller.setVisible(true)
    h.controller.setVisible(true)
    await h.settle()
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
    expect(h.delays).toEqual([5000])
  })

  it('holds the configured period when a refresh is cheap', async () => {
    const h = harness(5000)
    h.costMs = 40
    h.controller.setVisible(true)
    await h.settle()
    await h.tick()
    expect(h.delays).toEqual([5000, 5000])
  })

  it('backs off to a multiple of what a slow refresh actually cost', async () => {
    const h = harness(4000)
    // A real city answers `gc session list` in about three seconds; polling
    // every four leaves the panel permanently mid-read.
    h.costMs = 3000
    h.controller.setVisible(true)
    await h.settle()
    expect(h.delays).toEqual([15_000])
  })

  it('caps the backoff so a visible panel never goes quiet', async () => {
    const h = harness(4000, { maxIntervalMs: 30_000 })
    h.costMs = 120_000
    h.controller.setVisible(true)
    await h.settle()
    expect(h.delays).toEqual([30_000])
  })

  it('recovers the fast period once the host does', async () => {
    const h = harness(4000)
    h.costMs = 3000
    h.controller.setVisible(true)
    await h.settle()
    h.costMs = 20
    await h.tick()
    expect(h.delays).toEqual([15_000, 4000])
  })

  it('stops polling and does not refresh when hidden', async () => {
    const h = harness()
    h.controller.setVisible(true)
    await h.settle()
    h.onRefresh.mockClear()
    h.controller.setVisible(false)
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.onRefresh).not.toHaveBeenCalled()
  })

  it('does not schedule a poll for a refresh that finished after hiding', async () => {
    const h = harness()
    h.controller.setVisible(true)
    h.controller.setVisible(false)
    await h.settle()
    expect(h.delays).toEqual([])
  })

  it('refreshes on focus only while visible', async () => {
    const h = harness()
    h.controller.focus()
    expect(h.onRefresh).not.toHaveBeenCalled()
    h.controller.setVisible(true)
    await h.settle()
    h.onRefresh.mockClear()
    h.controller.focus()
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after a refresh throws', async () => {
    const h = harness()
    h.onRefresh.mockRejectedValueOnce(new Error('gc exploded'))
    h.controller.setVisible(true)
    await h.settle()
    expect(h.delays).toEqual([5000])
  })

  it('disposes: stops polling and makes every method a no-op', async () => {
    const h = harness()
    h.controller.setVisible(true)
    await h.settle()
    h.onRefresh.mockClear()
    h.controller.dispose()
    expect(h.cancel).toHaveBeenCalledOnce()
    h.controller.setVisible(true)
    h.controller.focus()
    expect(h.onRefresh).not.toHaveBeenCalled()
  })

  it('does not schedule a poll when the interval is non-positive', async () => {
    const h = harness(0)
    h.controller.setVisible(true)
    await h.settle()
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
    expect(h.delays).toEqual([])
  })
})
