/**
 * Ready detection while Away (ADR-049 Consequences): a terminal that goes quiet
 * while no hvir window is focused, hidden, or minimized must reach main's set as
 * Ready within the renderer quiet period plus slack, throttled renderer or not.
 */

import type { BrowserWindow } from 'electron'

import type { ActionableSnapshot } from '../attention/actionable-attention-set'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { SmokeAttention } from './attention-smoke'
import {
  AWAY_DEFAULT_HOLD_MS,
  AWAY_WINDOW_STATES,
  awayAppearanceViolations,
  awayReadyBudgetMs,
  formatAwayReadyMeasurement,
  judgeAwayReadyMeasurement,
  parseAwayHiddenHoldMs,
  type AwayReadyMeasurement,
  type AwayWindowState,
} from './attention-away-policy'
import { rendererFocusState, waitFor } from './attention-away-probe'
import { armAwayTerminal, type MeasuredTerminal } from './attention-away-terminal'
import { prepareTerminalScenario } from './terminal-scenario-ready'

export interface AttentionAwayThrottlingOptions {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly attention: SmokeAttention
  readonly resources: Pick<RendererResourceScopes, 'currentOwner'>
}

/** Measures quiet-to-Ready latency in every away state and fails on an overrun. */
export async function verifyAttentionAwayThrottlingScenario(
  options: AttentionAwayThrottlingOptions,
): Promise<string> {
  const { win, supervisor, attention, resources } = options
  await prepareTerminalScenario(win, supervisor)
  const terminal = supervisor.list()[0]
  if (!terminal) throw new Error('away throttling scenario has no terminal to measure')
  const owner = resources.currentOwner(win.webContents.id)
  const onFocus = (): void => attention.setOwnerFocused(owner, true)
  const onBlur = (): void => attention.setOwnerFocused(owner, false)
  win.on('focus', onFocus)
  win.on('blur', onBlur)
  attention.setOwnerFocused(owner, win.isFocused())
  const log: ActionableSnapshot[] = []
  const stopObserving = attention.set.observe((snapshot) => log.push(snapshot))
  try {
    const measurements: AwayReadyMeasurement[] = []
    for (const state of AWAY_WINDOW_STATES) {
      const measurement = await measureAwayState(options, terminal, state)
      console.log(`[smoke] away ready ${formatAwayReadyMeasurement(measurement)}`)
      const failure = judgeAwayReadyMeasurement(measurement)
      if (failure) throw new Error(`away throttling: ${failure}`)
      measurements.push(measurement)
    }
    const violations = awayAppearanceViolations(log, terminal.id)
    if (violations.length > 0) {
      throw new Error(`away throttling: focused appearances at ${violations.join(', ')}`)
    }
    return measurements.map(formatAwayReadyMeasurement).join('; ')
  } finally {
    stopObserving()
    win.removeListener('focus', onFocus)
    win.removeListener('blur', onBlur)
    await restoreWindow(win)
  }
}

async function measureAwayState(
  { win, supervisor, attention }: AttentionAwayThrottlingOptions,
  terminal: MeasuredTerminal,
  state: AwayWindowState,
): Promise<AwayReadyMeasurement> {
  const holdMs =
    state === 'hidden'
      ? parseAwayHiddenHoldMs(process.env.HVIR_SMOKE_AWAY_HIDDEN_HOLD_MS)
      : AWAY_DEFAULT_HOLD_MS
  await restoreWindow(win)
  await clearTerminalAttention(win, attention, terminal.id)
  const armed = await armAwayTerminal(win, supervisor, terminal, state)
  try {
    const honored = await applyAwayState(win, state)
    await waitFor(() => false, holdMs)
    await armed.burst()
    const readyAt = await waitForReady(attention, terminal.id)
    const renderer = await rendererFocusState(win)
    return {
      state,
      honored,
      quietToReadyMs: readyAt - armed.lastOutputAt(),
      holdMs,
      visibility: renderer.visibility,
      rendererFocused: renderer.focused,
      minimized: win.isMinimized(),
      away: attention.set.away(),
    }
  } finally {
    await armed.detach()
  }
}

/** Shows, restores and focuses the window until the renderer agrees it is focused. */
async function restoreWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  await waitFor(
    async () => (await rendererFocusState(win)).focused && win.isFocused(),
    10_000,
    'away throttling: window did not regain focus',
  )
}

/** Focuses the active terminal so any Ready it carried clears, then waits for main to agree. */
async function clearTerminalAttention(
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
    'away throttling: focusing the terminal did not clear its attention',
  )
}

/** Puts the window in the away state; reports whether the display honored it. */
async function applyAwayState(
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
    `away throttling: ${state} fallback blur left the renderer focused`,
  )
  return false
}

/** Resolves with the time main's set first carried the terminal as Ready. */
async function waitForReady(
  attention: SmokeAttention,
  terminalId: string,
): Promise<number> {
  const timeoutMs = awayReadyBudgetMs() + 60_000
  const carriesReady = (snapshot: ActionableSnapshot): boolean =>
    snapshot.entries.some((entry) => entry.key === terminalId && entry.kind === 'ready')
  let readyAt = carriesReady(attention.set.snapshot()) ? Date.now() : 0
  const stop = attention.set.observe((snapshot) => {
    if (readyAt === 0 && carriesReady(snapshot)) readyAt = Date.now()
  })
  try {
    const message = `away throttling: Ready never reached main within ${timeoutMs}ms`
    await waitFor(() => readyAt !== 0, timeoutMs, message)
  } finally {
    stop()
  }
  return readyAt
}
