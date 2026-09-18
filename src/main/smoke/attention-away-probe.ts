import type { BrowserWindow } from 'electron'

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
