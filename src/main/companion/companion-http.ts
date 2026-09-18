/**
 * Wire mechanics shared by the Companion routes: bounded JSON bodies, JSON
 * replies, bearer parsing, the text/event-stream writer, asset path
 * normalization, and the content-type map the asset reader uses.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

import type { CompanionAuthPort } from './companion-auth'

export const MAX_BODY_BYTES = 64 * 1024
export const SSE_HEARTBEAT_MS = 25_000
export const SSE_RETRY_MS = 3_000
/** Unsent bytes a stream may hold before a mirror is ended rather than buffered further. */
export const SSE_MAX_BACKLOG_BYTES = 4 * 1024 * 1024

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** A request the server answers with the given status instead of 500. */
export class CompanionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

/** Reads a JSON body of at most MAX_BODY_BYTES; 413 above, 400 when malformed. */
export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return Promise.reject(new CompanionHttpError(413, 'Request body too large'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        reject(new CompanionHttpError(413, 'Request body too large'))
        request.removeAllListeners('data')
        return
      }
      chunks.push(chunk)
    })
    request.once('error', reject)
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new CompanionHttpError(400, 'Request body is not JSON'))
      }
    })
  })
}

export function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization
  if (typeof value !== 'string') return undefined
  const [scheme, token, ...rest] = value.trim().split(/\s+/)
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return undefined
  return token
}

export function authorized(
  headers: IncomingHttpHeaders,
  auth: CompanionAuthPort,
): boolean {
  const token = bearerToken(headers)
  return token !== undefined && auth.verify(token)
}

/** The media type for an allowlisted bundle file, by extension. */
export function companionContentType(relativePath: string): string | undefined {
  const dot = relativePath.lastIndexOf('.')
  return dot < 0 ? undefined : CONTENT_TYPES[relativePath.slice(dot).toLowerCase()]
}

/**
 * Decodes one request path into a relative bundle path, or nothing when the
 * path is absolute, empty, traverses, hides a NUL, or does not decode.
 */
export function normalizeAssetPath(rawPath: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  if (decoded.length === 0 || decoded.includes('\0') || decoded.includes('\\'))
    return undefined
  const segments = decoded.split('/')
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return undefined
  }
  return segments.join('/')
}

/** The slice of ServerResponse an event stream writes through. */
export interface SseResponse {
  /** Bytes written but not yet handed to the socket. */
  readonly writableLength: number
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown
  flushHeaders(): void
  write(chunk: string): unknown
  end(): unknown
  once(event: 'close', listener: () => void): unknown
}

/** One text/event-stream response with a retry hint and periodic heartbeat. */
export class SseWriter {
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly closeListeners: (() => void)[] = []
  private ended = false

  constructor(
    private readonly response: SseResponse,
    headers: Readonly<Record<string, string>> = {},
  ) {
    response.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    response.flushHeaders()
    response.write(`retry: ${SSE_RETRY_MS}\n\n`)
    this.heartbeat = setInterval(() => this.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS)
    response.once('close', () => this.close())
  }

  get closed(): boolean {
    return this.ended
  }

  /** What the socket has not taken yet; a route bounds its own frames on it. */
  get backlog(): number {
    return this.response.writableLength
  }

  send(event: string, data: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  onClose(listener: () => void): void {
    if (this.ended) listener()
    else this.closeListeners.push(listener)
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    clearInterval(this.heartbeat)
    this.response.end()
    for (const listener of this.closeListeners.splice(0)) listener()
  }

  private write(frame: string): void {
    if (this.ended) return
    this.response.write(frame)
  }
}
