import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ app: { focus: vi.fn() } }))

vi.mock('electron', () => electron)

import type { BrowserWindow } from 'electron'

import { restoreWindow, withWindowRestored } from '../src/main/smoke/attention-away-window'

/** A window whose focus arrives after `focusAfterPolls` focus attempts; never with 0. */
function fakeWindow(focusAfterPolls: number | 'never') {
  let attempts = 0
  const focused = (): boolean => focusAfterPolls !== 'never' && attempts >= focusAfterPolls
  const focus = vi.fn(() => {
    attempts += 1
  })
  const contentsFocus = vi.fn()
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => focused(),
    focus,
    webContents: {
      focus: contentsFocus,
      executeJavaScript: () => Promise.resolve({ visibility: 'visible', focused: focused() }),
    },
  } as unknown as BrowserWindow
  return { win, focus, contentsFocus }
}

describe('restoreWindow', () => {
  afterEach(() => {
    vi.useRealTimers()
    electron.app.focus.mockClear()
  })

  it('steals app activation on every poll until the renderer and the window agree', async () => {
    const { win, focus, contentsFocus } = fakeWindow(3)

    await restoreWindow(win)

    expect(electron.app.focus.mock.calls).toEqual([
      [{ steal: true }],
      [{ steal: true }],
      [{ steal: true }],
    ])
    expect(focus).toHaveBeenCalledTimes(3)
    expect(contentsFocus).toHaveBeenCalledTimes(3)
  })

  it('does not touch activation when the window is already focused', async () => {
    const { win, focus } = fakeWindow(0)

    await restoreWindow(win)

    expect(electron.app.focus).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('withWindowRestored', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    electron.app.focus.mockClear()
  })

  it('returns the body result after restoring the window', async () => {
    const { win, focus } = fakeWindow(1)

    await expect(withWindowRestored(win, () => Promise.resolve('measured'))).resolves.toBe(
      'measured',
    )
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('reports a restore failure and rethrows the body error when the body failed', async () => {
    vi.useFakeTimers()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { win } = fakeWindow('never')
    const scenarioFailure = new Error('mirror away: no Push')

    const outcome = withWindowRestored(win, () => Promise.reject(scenarioFailure))
    const settled = outcome.then(
      () => 'resolved',
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(10_500)

    expect(await settled).toBe(scenarioFailure)
    expect(reported).toHaveBeenCalledWith(
      '[smoke] away window: window did not regain focus (after the scenario failed)',
    )
  })

  it('propagates a restore failure when the body succeeded', async () => {
    vi.useFakeTimers()
    const { win } = fakeWindow('never')

    const outcome = withWindowRestored(win, () => Promise.resolve('measured'))
    const settled = outcome.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : error),
    )
    await vi.advanceTimersByTimeAsync(10_500)

    expect(await settled).toBe('away window: window did not regain focus')
  })
})
