import { describe, expect, it, vi } from 'vitest'

import { AttentionBadge } from '../src/main/attention-badge'

describe('AttentionBadge', () => {
  it('aggregates distinct actionable terminals only while hvir is unfocused', () => {
    const setBadgeCount = vi.fn<(count: number) => boolean>(() => true)
    const badge = new AttentionBadge(setBadgeCount)

    badge.setFocused(1, true)
    badge.update(1, 2)
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([0])

    badge.setFocused(1, false)
    badge.update(2, 1)
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([0, 2, 3])

    badge.setFocused(2, true)
    expect(setBadgeCount).toHaveBeenLastCalledWith(0)
    badge.remove(2)
    expect(setBadgeCount).toHaveBeenLastCalledWith(2)
  })

  it('reports whether any hvir window is focused and notifies on change only', () => {
    const badge = new AttentionBadge(() => true)
    const listener = vi.fn()
    const stop = badge.windowFocus.observe(listener)

    expect(badge.windowFocus.isFocused()).toBe(false)
    badge.setFocused(1, true)
    badge.setFocused(2, true)
    expect(badge.windowFocus.isFocused()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()

    badge.setFocused(1, false)
    expect(listener).toHaveBeenCalledOnce()
    badge.remove(2)
    expect(badge.windowFocus.isFocused()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    stop()
    badge.setFocused(3, true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('caps the badge and avoids redundant platform calls', () => {
    const setBadgeCount = vi.fn<(count: number) => boolean>(() => true)
    const badge = new AttentionBadge(setBadgeCount)

    badge.update(1, 500)
    badge.update(1, 500)

    expect(setBadgeCount).toHaveBeenCalledOnce()
    expect(setBadgeCount).toHaveBeenCalledWith(99)
  })

  it('does not let stale generation cleanup erase current attention', () => {
    const setBadgeCount = vi.fn<(count: number) => boolean>(() => true)
    const badge = new AttentionBadge(setBadgeCount)
    badge.update(1, 4, 1)
    badge.update(1, 2, 2)

    badge.remove(1, 1)

    expect(setBadgeCount).toHaveBeenLastCalledWith(2)
  })

  it('stops quietly when the desktop has no badge implementation', () => {
    const setBadgeCount = vi.fn<(count: number) => boolean>(() => false)
    const badge = new AttentionBadge(setBadgeCount)

    badge.update(1, 1)
    badge.update(1, 2)

    expect(setBadgeCount).toHaveBeenCalledOnce()
  })
})
