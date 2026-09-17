/**
 * One HTTP exchange over a channel the host opened.
 *
 * ADR-047: hvir never dials a supervisor itself. It asks `ProjectHost` for a bounded
 * stream to a declared loopback endpoint and speaks HTTP over it, so a local
 * supervisor and one behind an SSH tunnel reach the same code with the same policy.
 * Every path here ends by destroying the channel it was given; a supervisor that
 * stops talking must not cost a held tunnel channel.
 */
import { Agent, request as requestHttp, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import type { LoopbackEndpoint } from '../../shared'

/** The host's loopback dialer, narrowed to what this client uses. */
export type SupervisorConnect = (endpoint: LoopbackEndpoint) => Promise<Duplex>

export interface SupervisorRequest {
  readonly method: 'GET' | 'POST'
  /** Encoded path with query string; the caller owns encoding. */
  readonly path: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs: number
}

export interface SupervisorHttpResponse {
  readonly status: number
  readonly body: string
}

/** Transport-level failures. HTTP status classification belongs to the client. */
export type SupervisorTransportFailure =
  | { readonly reason: 'unreachable'; readonly detail: string }
  | { readonly reason: 'timeout'; readonly detail: string }
  | { readonly reason: 'aborted'; readonly detail: string }
  | { readonly reason: 'protocol'; readonly detail: string }

export type SupervisorTransportResult =
  | { readonly ok: true; readonly response: SupervisorHttpResponse }
  | { readonly ok: false; readonly failure: SupervisorTransportFailure }

/** Bytes as the supervisor sends them, for a response that does not end. */
export interface SupervisorStreamHandlers {
  readonly onOpen?: (status: number) => void
  readonly onChunk: (chunk: string) => void
  readonly onClose: (failure?: SupervisorTransportFailure) => void
}

/** A live response. `close` is idempotent and releases the channel. */
export interface SupervisorStreamHandle {
  close(): void
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Reads one complete response, then closes the channel unconditionally. */
export async function supervisorRequest(
  connect: SupervisorConnect,
  endpoint: LoopbackEndpoint,
  request: SupervisorRequest,
): Promise<SupervisorTransportResult> {
  let channel: Duplex
  try {
    channel = await connect(endpoint)
  } catch (error) {
    return { ok: false, failure: { reason: 'unreachable', detail: message(error) } }
  }
  return await new Promise<SupervisorTransportResult>((resolve) => {
    const complete = finalizer(channel, resolve)
    function settle(result: SupervisorTransportResult): void {
      clearTimeout(deadline)
      complete(result)
    }
    const outgoing = open(channel, endpoint, request)
    // Timed here rather than through `request.setTimeout`, which reaches for a
    // `Socket` method the host's channel is not required to have.
    const deadline = setTimeout(() => {
      settle({
        ok: false,
        failure: { reason: 'timeout', detail: 'Supervisor did not respond' },
      })
    }, request.timeoutMs)
    deadline.unref?.()
    outgoing.once('error', (error) => {
      settle({ ok: false, failure: classifyRequestError(error) })
    })
    outgoing.once('response', (incoming: IncomingMessage) => {
      const chunks: string[] = []
      let size = 0
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk: string) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          settle({
            ok: false,
            failure: {
              reason: 'protocol',
              detail: 'Response exceeded the accepted size',
            },
          })
          return
        }
        chunks.push(chunk)
      })
      incoming.once('error', (error) => {
        settle({ ok: false, failure: { reason: 'protocol', detail: message(error) } })
      })
      incoming.once('end', () => {
        settle({
          ok: true,
          response: { status: incoming.statusCode ?? 0, body: chunks.join('') },
        })
      })
    })
    if (request.body !== undefined) outgoing.write(request.body)
    outgoing.end()
  })
}

/**
 * Opens a response the caller reads until it decides to stop. The handle owns the
 * channel: closing it destroys the request and the stream, in that order.
 */
export async function supervisorStream(
  connect: SupervisorConnect,
  endpoint: LoopbackEndpoint,
  request: SupervisorRequest,
  handlers: SupervisorStreamHandlers,
): Promise<SupervisorStreamHandle> {
  let channel: Duplex
  try {
    channel = await connect(endpoint)
  } catch (error) {
    handlers.onClose({ reason: 'unreachable', detail: message(error) })
    return { close: () => {} }
  }
  let closed = false
  const outgoing = open(channel, endpoint, request)
  const finish = (failure?: SupervisorTransportFailure): void => {
    if (closed) return
    closed = true
    outgoing.destroy()
    channel.destroy()
    handlers.onClose(failure)
  }
  // No response timeout: an idle stream is normal, and the server sends heartbeats.
  outgoing.once('error', (error) => {
    finish(closed ? undefined : classifyRequestError(error))
  })
  outgoing.once('response', (incoming: IncomingMessage) => {
    handlers.onOpen?.(incoming.statusCode ?? 0)
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => {
      if (!closed) handlers.onChunk(chunk)
    })
    incoming.once('error', (error) => {
      finish({ reason: 'protocol', detail: message(error) })
    })
    incoming.once('end', () => {
      finish({ reason: 'protocol', detail: 'Supervisor ended the stream' })
    })
  })
  outgoing.end()
  return { close: () => finish() }
}

function open(
  channel: Duplex,
  endpoint: LoopbackEndpoint,
  request: SupervisorRequest,
): ReturnType<typeof requestHttp> {
  // One exchange per channel: the host opened exactly one stream for this request.
  const agent = new Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = () => channel
  const outgoing = requestHttp({
    protocol: 'http:',
    hostname: endpoint.hostname === '::1' ? '::1' : endpoint.hostname,
    port: endpoint.port,
    method: request.method,
    path: request.path,
    headers: { ...request.headers, connection: 'close' },
    agent,
  })
  outgoing.once('close', () => agent.destroy())
  return outgoing
}

/** Resolves once, and only after the channel is gone. */
function finalizer(
  channel: Duplex,
  resolve: (result: SupervisorTransportResult) => void,
): (result: SupervisorTransportResult) => void {
  let settled = false
  return (result) => {
    if (settled) return
    settled = true
    channel.destroy()
    resolve(result)
  }
}

function classifyRequestError(error: unknown): SupervisorTransportFailure {
  const detail = message(error)
  const code = (error as { code?: string } | null)?.code
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE')
    return { reason: 'unreachable', detail }
  if (code === 'ETIMEDOUT') return { reason: 'timeout', detail }
  if (code === 'ABORT_ERR') return { reason: 'aborted', detail }
  return { reason: 'protocol', detail }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
