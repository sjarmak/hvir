/**
 * Puts the smoke window into and out of the away states the Away scenarios
 * measure (ADR-049, ADR-050), and clears a terminal's attention the way a
 * person does: by focusing it.
 */

import { app, type BrowserWindow } from 'electron'

import type { AwayWindowState } from './attention-away-policy'
import { rendererFocusState, waitFor } from './attention-away-probe'
import type { SmokeAttention } from './attention-smoke'

/**
 * Shows, restores and focuses the window until the renderer agrees it is
 * focused. The app steals activation on every poll because a smoke launched
 * from a shell is not the frontmost app and `win.focus()` alone never makes it so.
 */
export async function restoreWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  await waitFor(
    async () => {
      if ((await rendererFocusState(win)).focused && win.isFocused()) return true
      app.focus({ steal: true })
      win.focus()
      win.webContents.focus()
      return false
    },
    10_000,
    'away window: window did not regain focus',
  )
}

/**
 * Runs a scenario body and restores the window afterwards. When the body
 * fails, a restore failure is reported and the body's own error propagates,
 * so the run output names the step that actually failed.
 */
export async function withWindowRestored<T>(
  win: BrowserWindow,
  body: () => Promise<T>,
): Promise<T> {
  let result: T
  try {
    result = await body()
  } catch (error) {
    try {
      await restoreWindow(win)
    } catch (restoreError) {
      console.error(`[smoke] ${messageOf(restoreError)} (after the scenario failed)`)
    }
    throw error
  }
  await restoreWindow(win)
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Focuses the active terminal so any Ready it carried clears, then waits for main to agree. */
export async function clearTerminalAttention(
  win: BrowserWindow,
  attention: SmokeAttention,
  terminalId: string,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const surface = document.querySelector(
        '.terminal-surface[data-terminal-session="' + CSS.escape(${JSON.stringify(terminalId)}) + '"]'
      );
      const container = surface?.querySelector('.terminal-container');
      container?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      surface?.querySelector('.terminal-engine-host')?.focus();
    })()
  `)
  await waitFor(
    () =>
      !attention.set.away() &&
      !attention.set.snapshot().entries.some((entry) => entry.key === terminalId),
    10_000,
    'away window: focusing the terminal did not clear its attention',
  )
}

/** Puts the window in the away state; reports whether the display honored it. */
export async function applyAwayState(
  win: BrowserWindow,
  state: AwayWindowState,
): Promise<boolean> {
  if (state === 'visible-unfocused') win.blur()
  if (state === 'hidden') win.hide()
  if (state === 'minimized') win.minimize()
  const honored = await waitFor(async () => {
    const renderer = await rendererFocusState(win)
    if (renderer.focused || win.isFocused()) return false
    if (state === 'minimized' && !win.isMinimized()) return false
    return state === 'visible-unfocused' || renderer.visibility === 'hidden'
  }, 5_000)
  if (honored) return true
  win.blur()
  await waitFor(
    async () => !(await rendererFocusState(win)).focused && !win.isFocused(),
    5_000,
    `away window: ${state} fallback blur left the renderer focused`,
  )
  return false
}
