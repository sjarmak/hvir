import { BrowserWindow, dialog, shell, webContents } from 'electron'
import { isSafeExternalUrl } from '../navigation-policy'
import type { RendererOwner } from '../renderer-resource-scopes'
import { extensionObject, extensionText } from '../../shared/extensions/validation'

interface ExternalUrlCaller {
  readonly owner: RendererOwner
}

interface ExternalUrlDecision {
  readonly url: string
  readonly origin: string
}

const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

export type ConfirmExternalUrl = (
  decision: ExternalUrlDecision,
  signal: AbortSignal,
  owner: RendererOwner,
) => Promise<boolean>

function safeExternalUrl(rawUrl: string): URL | undefined {
  try {
    if (BIDI_CONTROL.test(rawUrl)) return undefined
    const url = new URL(rawUrl)
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      isSafeExternalUrl(url.href)
      ? url
      : undefined
  } catch {
    return undefined
  }
}

export function safeExternalOrigin(rawUrl: string): string | undefined {
  return safeExternalUrl(rawUrl)?.origin
}

export const confirmExternalUrl: ConfirmExternalUrl = async (decision, signal, owner) => {
  signal.throwIfAborted()
  const contents = webContents.fromId(owner.id)
  const window = contents ? BrowserWindow.fromWebContents(contents) : undefined
  if (!window || window.isDestroyed()) throw new Error('Extension window was revoked')
  const result = await dialog.showMessageBox(window, {
    signal,
    type: 'question',
    buttons: ['Cancel', 'Open in browser'],
    defaultId: 0,
    cancelId: 0,
    title: 'Open an external website',
    message: decision.origin,
    detail: decision.url,
  })
  signal.throwIfAborted()
  return result.response === 1
}

export class ExtensionSafeExternalUrl {
  constructor(
    private readonly confirm: ConfirmExternalUrl = confirmExternalUrl,
    private readonly launch: (url: string) => Promise<void> = (url) =>
      shell.openExternal(url),
  ) {}

  async open(
    caller: ExternalUrlCaller,
    value: unknown,
    current: () => void,
    signal: AbortSignal,
  ): Promise<null> {
    current()
    signal.throwIfAborted()
    const input = extensionObject(value)
    const parsed = safeExternalUrl(extensionText(input['url'], 'external URL', 4096))
    if (!parsed) throw new Error('External URLs must use HTTPS')
    const url = parsed.href
    const accepted = await this.confirm(
      { url, origin: parsed.origin },
      signal,
      caller.owner,
    )
    current()
    signal.throwIfAborted()
    if (!accepted) throw new Error('External URL opening was cancelled')
    await this.launch(url)
    return null
  }
}
