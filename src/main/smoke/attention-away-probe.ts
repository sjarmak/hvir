import type { BrowserWindow } from 'electron'

import type { ActionableKind } from '../../shared'
import type {
  ActionableSnapshot,
  MainActionableEntry,
} from '../attention/actionable-attention-set'
import { awayReadyBudgetMs } from './attention-away-policy'
import type { SmokeAttention } from './attention-smoke'

export type RendererFocusState = {
  readonly visibility: string
  readonly focused: boolean
}

export async function rendererFocusState(
  win: BrowserWindow,
): Promise<RendererFocusState> {
  return (await win.webContents.executeJavaScript(
    `({ visibility: document.visibilityState, focused: document.hasFocus() })`,
  )) as RendererFocusState
}

/** Polls until the predicate holds; a message turns the timeout into a failure. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (message !== undefined) throw new Error(message)
  return false
}

/** The entry main's set first carried for the terminal as `kind`, and when. */
export interface ActionableArrival {
  readonly at: number
  readonly entry: MainActionableEntry
}

export async function waitForActionable(
  attention: SmokeAttention,
  terminalId: string,
  kind: ActionableKind,
  timeoutMs: number,
): Promise<ActionableArrival> {
  const carried = (snapshot: ActionableSnapshot): MainActionableEntry | undefined =>
    snapshot.entries.find((entry) => entry.key === terminalId && entry.kind === kind)
  const first = carried(attention.set.snapshot())
  let arrival: ActionableArrival | undefined =
    first === undefined ? undefined : { at: Date.now(), entry: first }
  const stop = attention.set.observe((snapshot) => {
    if (arrival !== undefined) return
    const entry = carried(snapshot)
    if (entry !== undefined) arrival = { at: Date.now(), entry }
  })
  try {
    const message = `away probe: ${kind} never reached main within ${timeoutMs}ms`
    await waitFor(() => arrival !== undefined, timeoutMs, message)
  } finally {
    stop()
  }
  if (arrival === undefined) throw new Error(`away probe: ${kind} arrival lost`)
  return arrival
}

/** Resolves with the time main's set first carried the terminal as Ready. */
export async function waitForReady(
  attention: SmokeAttention,
  terminalId: string,
): Promise<number> {
  const timeoutMs = awayReadyBudgetMs() + 60_000
  return (await waitForActionable(attention, terminalId, 'ready', timeoutMs)).at
}
