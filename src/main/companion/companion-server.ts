/**
 * The Companion listener: hvir's one inbound network socket (ADR-049).
 *
 * ADR-010 forbids any hvir-owned remote server; ADR-049 narrows that to this
 * single loopback-bound listener that lives inside the running app, is off
 * until Settings opens it, and dies with the process. Reaching it from another
 * device is the operator's act through the operator's tooling. Inside that
 * wall, pairing is the only way to a credential, so reachability is never
 * treated as authentication.
 *
 * The connection posture (header cap, timeouts, socket cap, clientError 400)
 * is copied from src/main/web-pane/loopback-http-proxy.ts rather than
 * extracted: two listeners share a posture, not an implementation, and the
 * rule of three has not been met.
 */
import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import {
  COMPANION_INDEX_PATH,
  PAIRING_FAILURE_WINDOW_MS,
  PairingRateLimiter,
  type CompanionAsset,
  type CompanionAssetReader,
  type CompanionAuthPort,
} from './companion-auth'
import {
  CompanionHttpError,
  SseWriter,
  authorized,
  json,
  normalizeAssetPath,
  readJsonBody,
} from './companion-http'
import { CompanionRouter, type CompanionRequestContext } from './companion-router'

const MAX_CONNECTIONS = 32
const MAX_HEADER_BYTES = 16 * 1024
const MIN_PORT = 1024
const MAX_PORT = 65_535

export interface CompanionDiagnostic {
  readonly kind: 'request-failure'
  readonly message: string
  readonly path: string
}

export interface CompanionServerOptions {
  readonly auth: CompanionAuthPort
  readonly assets: CompanionAssetReader
  readonly now?: () => number
  readonly onDiagnostic?: (event: CompanionDiagnostic) => void
}

export class CompanionServer {
  readonly router = new CompanionRouter()

  private readonly pairing: PairingRateLimiter
  private readonly clients = new Set<Socket>()
  private readonly streams = new Set<SseWriter>()
  private server: Server | undefined

  constructor(private readonly options: CompanionServerOptions) {
    this.pairing = new PairingRateLimiter(options.now)
    this.router.register('GET', '/', (context) =>
      this.serveAsset(context, COMPANION_INDEX_PATH),
    )
    this.router.register('GET', '/assets/*', (context) =>
      this.serveWildcardAsset(context),
    )
    this.router.register('POST', '/pair', (context) => this.pair(context))
  }

  get listening(): boolean {
    return this.server?.listening ?? false
  }

  get address(): { readonly address: string; readonly port: number } | undefined {
    const address = this.server?.address()
    return address && typeof address !== 'string' ? address : undefined
  }

  get port(): number | undefined {
    return this.address?.port
  }

  get openStreams(): number {
    return this.streams.size
  }

  async open(port: number): Promise<void> {
    if (this.server) throw new Error('Companion server is already open')
    if (!Number.isInteger(port) || (port !== 0 && (port < MIN_PORT || port > MAX_PORT))) {
      throw new Error(
        `Companion port must be an integer between ${MIN_PORT} and ${MAX_PORT}`,
      )
    }
    const server = this.createListener()
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.server = undefined
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    for (const stream of this.streams) stream.close()
    this.streams.clear()
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    if (!server.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private createListener(): Server {
    const server = createServer(
      { maxHeaderSize: MAX_HEADER_BYTES },
      (request, response) => {
        void this.dispatch(request, response)
      },
    )
    server.on('connection', (socket) => {
      if (this.clients.size >= MAX_CONNECTIONS) {
        socket.destroy()
        return
      }
      this.clients.add(socket)
      socket.once('close', () => this.clients.delete(socket))
    })
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    server.keepAliveTimeout = 5_000
    return server
  }

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const target = request.url ?? '/'
    const url = requestUrl(target)
    if (!url) {
      json(response, 400, { error: 'Bad request target' })
      return
    }
    if (
      url.pathname.startsWith('/api/') &&
      !authorized(request.headers, this.options.auth)
    ) {
      response.setHeader('www-authenticate', 'Bearer')
      json(response, 401, { error: 'Unauthorized' })
      return
    }
    const match = this.router.resolve(request.method ?? '', target)
    if (match.kind === 'not-found') {
      json(response, 404, { error: 'Not found' })
      return
    }
    if (match.kind === 'method-not-allowed') {
      response.setHeader('allow', match.allow.join(', '))
      json(response, 405, { error: 'Method not allowed' })
      return
    }
    const context: CompanionRequestContext = {
      request,
      response,
      url,
      params: match.params,
      openEventStream: (headers) => this.openEventStream(response, headers),
    }
    try {
      await match.handler(context)
    } catch (error) {
      this.failResponse(response, url.pathname, error)
    }
  }

  private failResponse(response: ServerResponse, path: string, error: unknown): void {
    if (error instanceof CompanionHttpError) {
      if (!response.headersSent) json(response, error.status, { error: error.message })
      return
    }
    this.options.onDiagnostic?.({
      kind: 'request-failure',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      path,
    })
    if (!response.headersSent) json(response, 500, { error: 'Internal error' })
    else response.destroy()
  }

  private openEventStream(
    response: ServerResponse,
    headers?: Readonly<Record<string, string>>,
  ): SseWriter {
    const stream = new SseWriter(response, headers)
    this.streams.add(stream)
    stream.onClose(() => this.streams.delete(stream))
    return stream
  }

  private serveWildcardAsset(context: CompanionRequestContext): Promise<void> {
    const relative = normalizeAssetPath(context.params['*'] ?? '')
    if (relative === undefined) {
      json(context.response, 404, { error: 'Not found' })
      return Promise.resolve()
    }
    return this.serveAsset(
      context,
      `assets/${relative}`,
      'public, max-age=31536000, immutable',
    )
  }

  private async serveAsset(
    context: CompanionRequestContext,
    relativePath: string,
    cacheControl = 'no-store',
  ): Promise<void> {
    const asset: CompanionAsset | undefined = await this.options.assets.read(relativePath)
    if (!asset) {
      json(context.response, 404, { error: 'Not found' })
      return
    }
    context.response.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': asset.body.byteLength,
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    context.response.end(asset.body)
  }

  private async pair(context: CompanionRequestContext): Promise<void> {
    if (this.pairing.blocked()) {
      context.response.setHeader('retry-after', String(PAIRING_FAILURE_WINDOW_MS / 1000))
      json(context.response, 429, { error: 'Too many pairing attempts' })
      return
    }
    const code = pairingCode(await readJsonBody(context.request))
    if (code === undefined) throw new CompanionHttpError(400, 'Expected {"code": string}')
    const token = this.options.auth.exchange(code)
    if (token === undefined) {
      this.pairing.fail()
      json(context.response, 401, { error: 'Pairing code rejected' })
      return
    }
    json(context.response, 200, { token })
  }
}

function requestUrl(target: string): URL | undefined {
  try {
    return new URL(target, 'http://127.0.0.1')
  } catch {
    return undefined
  }
}

function pairingCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 && code.length <= 128
    ? code
    : undefined
}
