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
  formatAwayReadyMeasurement,
  judgeAwayReadyMeasurement,
  parseAwayHiddenHoldMs,
  type AwayReadyMeasurement,
  type AwayWindowState,
} from './attention-away-policy'
import { rendererFocusState, waitFor, waitForReady } from './attention-away-probe'
import { armAwayTerminal, type MeasuredTerminal } from './attention-away-terminal'
import {
  applyAwayState,
  clearTerminalAttention,
  restoreWindow,
  withWindowRestored,
} from './attention-away-window'
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
  return withWindowRestored(win, async () => {
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
    }
  })
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
