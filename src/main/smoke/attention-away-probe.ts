import type { BrowserWindow } from 'electron'

import type { ActionableSnapshot } from '../attention/actionable-attention-set'
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

/** Resolves with the time main's set first carried the terminal as Ready. */
export async function waitForReady(
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
    const message = `away probe: Ready never reached main within ${timeoutMs}ms`
    await waitFor(() => readyAt !== 0, timeoutMs, message)
  } finally {
    stop()
  }
  return readyAt
}
