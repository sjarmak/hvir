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

export type ConfirmExternalUrl = (
  decision: ExternalUrlDecision,
  signal: AbortSignal,
  owner: RendererOwner,
) => Promise<boolean>

export function safeExternalOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && isSafeExternalUrl(rawUrl) ? url.origin : undefined
  } catch {
    return undefined
  }
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
    const url = extensionText(input['url'], 'external URL', 4096)
    const origin = safeExternalOrigin(url)
    if (!origin) throw new Error('External URLs must use HTTPS')
    const accepted = await this.confirm({ url, origin }, signal, caller.owner)
    current()
    signal.throwIfAborted()
    if (!accepted) throw new Error('External URL opening was cancelled')
    await this.launch(url)
    return null
  }
}
