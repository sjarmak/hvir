import { describe, expect, it, vi } from 'vitest'

import { createVisibilityRefresh } from '../src/renderer/src/beads/beads-refresh'

/** Drives the controller with injected timer fns so no real clock is involved. */
function harness(intervalMs = 5000): {
  readonly onRefresh: ReturnType<typeof vi.fn>
  readonly schedule: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly controller: ReturnType<typeof createVisibilityRefresh>
  readonly tick: () => void
} {
  const onRefresh = vi.fn()
  let scheduled: (() => void) | undefined
  const schedule = vi.fn((cb: () => void) => {
    scheduled = cb
    return 1 as unknown as ReturnType<typeof setInterval>
  })
  const cancel = vi.fn()
  const controller = createVisibilityRefresh({ onRefresh, intervalMs, schedule, cancel })
  return { onRefresh, schedule, cancel, controller, tick: () => scheduled?.() }
}

describe('createVisibilityRefresh', () => {
  it('refreshes immediately on becoming visible and then polls', () => {
    const { onRefresh, schedule, controller, tick } = harness()
    controller.setVisible(true)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledOnce()
    tick()
    tick()
    expect(onRefresh).toHaveBeenCalledTimes(3)
  })

  it('is idempotent: re-showing does not double-refresh or double-schedule', () => {
    const { onRefresh, schedule, controller } = harness()
    controller.setVisible(true)
    controller.setVisible(true)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('stops polling and does not refresh when hidden', () => {
    const { onRefresh, cancel, controller } = harness()
    controller.setVisible(true)
    onRefresh.mockClear()
    controller.setVisible(false)
    expect(cancel).toHaveBeenCalledOnce()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('refreshes on focus only while visible', () => {
    const { onRefresh, controller } = harness()
    controller.focus()
    expect(onRefresh).not.toHaveBeenCalled()
    controller.setVisible(true)
    onRefresh.mockClear()
    controller.focus()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disposes: stops polling and makes every method a no-op', () => {
    const { onRefresh, cancel, controller } = harness()
    controller.setVisible(true)
    onRefresh.mockClear()
    controller.dispose()
    expect(cancel).toHaveBeenCalledOnce()
    controller.setVisible(true)
    controller.focus()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('does not schedule a poll when the interval is non-positive', () => {
    const { schedule, onRefresh, controller } = harness(0)
    controller.setVisible(true)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(schedule).not.toHaveBeenCalled()
  })
})
