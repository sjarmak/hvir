/**
 * The declared notification sink a Push is posted to (ADR-049).
 *
 * One bounded attempt per message in ADR-047's posture: a declared endpoint,
 * a timeout, no discovery and no second attempt. The sink speaks ntfy's publish shape
 * (a text body, a Title header, an optional bearer) because that is what the
 * operator runbook declares; which server answers is operator infrastructure.
 * The token is read from Settings at send time and never written anywhere.
 */
import type { ActionableKind } from '../../shared'
import type { CompanionSettings } from './companion-settings'

export interface PushMessage {
  readonly project: string
  readonly title: string
  readonly kind: ActionableKind
  /** First line of the pending prompt, already bounded; never options. */
  readonly line?: string
}

export type PushFailureReason =
  | 'not-configured'
  | 'timeout'
  | 'unreachable'
  | 'rejected'
  | 'protocol'

export type PushOutcome =
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'failed'; readonly reason: PushFailureReason }

export interface PushSink {
  send(message: PushMessage): Promise<PushOutcome>
}

export const PUSH_TIMEOUT_MS = 10_000

export interface NtfyPushSinkOptions {
  readonly url: string
  readonly token?: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

export function createNtfyPushSink(options: NtfyPushSinkOptions): PushSink {
  const post = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS
  return {
    send: async (message) => {
      if (options.url === '') return { outcome: 'failed', reason: 'not-configured' }
      let response: Response
      try {
        response = await post(options.url, {
          method: 'POST',
          headers: headersFor(message, options.token),
          body: bodyFor(message),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
        })
      } catch (error) {
        return { outcome: 'failed', reason: isTimeout(error) ? 'timeout' : 'unreachable' }
      }
      return classify(response)
    },
  }
}

/**
 * Reads the sink Settings declares each time it is asked, so a changed url or
 * token takes effect on the next appearance without a restart.
 */
export function companionPushSinkFactory(
  settings: Pick<CompanionSettings, 'view' | 'pushToken'>,
  options: Pick<NtfyPushSinkOptions, 'fetch' | 'timeoutMs'> = {},
): () => PushSink | undefined {
  return () => {
    const push = settings.view().push
    if (push === undefined || push.url === '') return undefined
    const token = push.tokenConfigured ? settings.pushToken() : undefined
    return createNtfyPushSink({
      ...options,
      url: push.url,
      ...(token === undefined ? {} : { token }),
    })
  }
}

function headersFor(message: PushMessage, token: string | undefined): Record<string, string> {
  return {
    'content-type': 'text/plain; charset=utf-8',
    title: message.kind,
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

function bodyFor(message: PushMessage): string {
  const pointer = `${message.project} / ${message.title}`
  return message.line === undefined ? pointer : `${pointer}\n${message.line}`
}

function classify(response: Response | undefined): PushOutcome {
  if (response === undefined || typeof response.status !== 'number') {
    return { outcome: 'failed', reason: 'protocol' }
  }
  // The answer body is nothing hvir reads; releasing it returns the socket.
  void response.body?.cancel().catch(() => undefined)
  const { status } = response
  if (status >= 200 && status < 300) return { outcome: 'sent' }
  if (status >= 400 && status < 600) return { outcome: 'failed', reason: 'rejected' }
  return { outcome: 'failed', reason: 'protocol' }
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}
