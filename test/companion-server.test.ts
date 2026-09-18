import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { connect as connectSocket, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CompanionAsset,
  CompanionAssetReader,
  CompanionAuthPort,
} from '../src/main/companion/companion-auth'
import {
  CompanionHttpError,
  SseWriter,
  json,
  type SseResponse,
} from '../src/main/companion/companion-http'
import { CompanionServer } from '../src/main/companion/companion-server'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PAIRING_CODE = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX'
const TOKEN = 'companion-token-1234567890'

function fakeAuth(): CompanionAuthPort & { exchanges: string[] } {
  let outstanding = true
  const auth = {
    exchanges: [] as string[],
    exchange(code: string): string | undefined {
      auth.exchanges.push(code)
      if (!outstanding || code !== PAIRING_CODE) return undefined
      outstanding = false
      return TOKEN
    },
    verify(token: string): boolean {
      return token === TOKEN
    },
  }
  return auth
}

function fakeAssets(): CompanionAssetReader & { reads: string[] } {
  const files = new Map<string, CompanionAsset>([
    [
      'companion/index.html',
      {
        body: Buffer.from('<!doctype html><title>Companion</title>'),
        contentType: 'text/html; charset=utf-8',
      },
    ],
    [
      'assets/app-abc123.js',
      { body: Buffer.from('console.log(1)'), contentType: 'text/javascript' },
    ],
  ])
  const reader = {
    reads: [] as string[],
    read(relativePath: string): Promise<CompanionAsset | undefined> {
      reader.reads.push(relativePath)
      return Promise.resolve(files.get(relativePath))
    },
  }
  return reader
}

async function openServer(
  options: Partial<ConstructorParameters<typeof CompanionServer>[0]> = {},
): Promise<{ server: CompanionServer; port: number; auth: ReturnType<typeof fakeAuth> }> {
  const auth = fakeAuth()
  const server = new CompanionServer({ auth, assets: fakeAssets(), ...options })
  await server.open(0)
  cleanups.push(() => server.close())
  const port = server.port
  if (port === undefined) throw new Error('server reported no port')
  return { server, port, auth }
}

interface Reply {
  readonly status: number | undefined
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: OutgoingHttpHeaders; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: options.headers,
    })
    let body = ''
    request.on('response', (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      )
    })
    request.on('error', reject)
    request.end(options.body)
  })
}

function pair(port: number, code: unknown, raw?: string): Promise<Reply> {
  return send(port, 'POST', '/pair', {
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify({ code }),
  })
}

function bearer(token: string): OutgoingHttpHeaders {
  return { authorization: `Bearer ${token}` }
}

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function fakeResponse(): {
  response: PassThrough & SseResponse
  writeHead: ReturnType<typeof vi.fn<SseResponse['writeHead']>>
} {
  const writeHead = vi.fn<SseResponse['writeHead']>()
  const response = Object.assign(new PassThrough(), {
    writeHead,
    flushHeaders: vi.fn<SseResponse['flushHeaders']>(),
  })
  return { response, writeHead }
}

describe('CompanionServer listener', () => {
  it('is off until opened and binds the loopback interface only', async () => {
    const server = new CompanionServer({ auth: fakeAuth(), assets: fakeAssets() })
    expect(server.listening).toBe(false)
    expect(server.port).toBeUndefined()
    await server.open(0)
    cleanups.push(() => server.close())
    expect(server.listening).toBe(true)
    expect(server.address?.address).toBe('127.0.0.1')
    expect(server.port).toBe(server.address?.port)
  })

  it('rejects a port outside the configurable range', async () => {
    const server = new CompanionServer({ auth: fakeAuth(), assets: fakeAssets() })
    for (const port of [80, 1023, 65_536, 1.5, Number.NaN]) {
      await expect(server.open(port)).rejects.toThrow('Companion port')
    }
    expect(server.listening).toBe(false)
  })

  it('refuses to open twice and can reopen after close', async () => {
    const { server } = await openServer()
    await expect(server.open(0)).rejects.toThrow('already open')
    await server.close()
    expect(server.listening).toBe(false)
    await server.open(0)
    expect(server.listening).toBe(true)
  })
})

describe('CompanionServer static routes', () => {
  it('serves the reader index for GET / without authentication', async () => {
    const assets = fakeAssets()
    const { port } = await openServer({ assets })
    const reply = await send(port, 'GET', '/')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.body).toContain('<title>Companion</title>')
    expect(assets.reads).toEqual(['companion/index.html'])
  })

  it('serves an asset through the reader under assets/', async () => {
    const assets = fakeAssets()
    const { port } = await openServer({ assets })
    const reply = await send(port, 'GET', '/assets/app-abc123.js?v=1')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('text/javascript')
    expect(reply.body).toBe('console.log(1)')
    expect(assets.reads).toEqual(['assets/app-abc123.js'])
    expect((await send(port, 'GET', '/assets/missing.js')).status).toBe(404)
  })

  it('never asks the reader for a traversing or absolute asset path', async () => {
    const assets = fakeAssets()
    const { port } = await openServer({ assets })
    for (const path of [
      '/assets/../companion/index.html',
      '/assets/%2e%2e/companion/index.html',
      '/assets/..%2fcompanion/index.html',
      '/assets//etc/passwd',
      '/assets/%00.js',
      '/assets/a%ZZ.js',
    ]) {
      expect((await send(port, 'GET', path)).status, path).toBe(404)
    }
    expect(assets.reads).toEqual([])
  })

  it('answers 404 for an unknown path and 405 for a known path with the wrong method', async () => {
    const { port } = await openServer()
    expect((await send(port, 'GET', '/nope')).status).toBe(404)
    const wrongMethod = await send(port, 'GET', '/pair')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.allow).toBe('POST')
  })
})

describe('CompanionServer pairing', () => {
  it('exchanges the outstanding code for a token exactly once', async () => {
    const { port } = await openServer()
    const first = await pair(port, PAIRING_CODE)
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body)).toEqual({ token: TOKEN })
    expect(first.headers['cache-control']).toBe('no-store')
    expect((await pair(port, PAIRING_CODE)).status).toBe(401)
  })

  it('answers 401 for a wrong code and 429 on the sixth failure within a minute', async () => {
    const { port, auth } = await openServer()
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await pair(port, 'WRONG')).status).toBe(401)
    }
    const limited = await pair(port, PAIRING_CODE)
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
    expect(auth.exchanges).toHaveLength(5)
  })

  it('lets pairing resume once the failure window has passed', async () => {
    let clock = 1_000_000
    const { port } = await openServer({ now: () => clock })
    for (let attempt = 0; attempt < 5; attempt++) await pair(port, 'WRONG')
    expect((await pair(port, PAIRING_CODE)).status).toBe(429)
    clock += 60_001
    expect((await pair(port, PAIRING_CODE)).status).toBe(200)
  })

  it('answers 400 for a malformed pairing body', async () => {
    const { port, auth } = await openServer()
    expect((await pair(port, undefined, '{not json')).status).toBe(400)
    expect((await pair(port, 42)).status).toBe(400)
    expect((await pair(port, undefined, '[]')).status).toBe(400)
    expect(auth.exchanges).toEqual([])
  })

  it('answers 413 for a body over 64 KiB', async () => {
    const { port } = await openServer()
    const reply = await pair(
      port,
      undefined,
      JSON.stringify({ code: 'x'.repeat(70 * 1024) }),
    )
    expect(reply.status).toBe(413)
  })
})

describe('CompanionServer bearer protection', () => {
  it('guards every /api route with the paired bearer token', async () => {
    const { server, port } = await openServer()
    server.router.register('GET', '/api/ping', ({ response }) =>
      json(response, 200, { ok: true }),
    )
    const anonymous = await send(port, 'GET', '/api/ping')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers['www-authenticate']).toBe('Bearer')
    expect(
      (await send(port, 'GET', '/api/ping', { headers: bearer('nope') })).status,
    ).toBe(401)
    expect(
      (await send(port, 'GET', '/api/ping', { headers: { authorization: 'Basic xyz' } }))
        .status,
    ).toBe(401)
    const accepted = await send(port, 'GET', '/api/ping', { headers: bearer(TOKEN) })
    expect(accepted.status).toBe(200)
    expect(JSON.parse(accepted.body)).toEqual({ ok: true })
  })

  it('demands the bearer before revealing whether an /api route exists', async () => {
    const { port } = await openServer()
    expect((await send(port, 'GET', '/api/unknown')).status).toBe(401)
    expect(
      (await send(port, 'GET', '/api/unknown', { headers: bearer(TOKEN) })).status,
    ).toBe(404)
  })

  it('exposes only the static and pairing routes by itself', async () => {
    const { server } = await openServer()
    expect(server.router.routes()).toEqual(['GET /', 'GET /assets/*', 'POST /pair'])
  })
})

describe('CompanionServer handler failures', () => {
  it('maps a CompanionHttpError to its status and anything else to 500', async () => {
    const onDiagnostic = vi.fn()
    const { server, port } = await openServer({ onDiagnostic })
    server.router.register('GET', '/api/bad-request', () => {
      throw new CompanionHttpError(400, 'Bad handle')
    })
    server.router.register('GET', '/api/broken', () =>
      Promise.reject(new Error('secret detail')),
    )
    const bad = await send(port, 'GET', '/api/bad-request', { headers: bearer(TOKEN) })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body)).toEqual({ error: 'Bad handle' })
    const broken = await send(port, 'GET', '/api/broken', { headers: bearer(TOKEN) })
    expect(broken.status).toBe(500)
    expect(broken.body).not.toContain('secret detail')
    expect(onDiagnostic).toHaveBeenCalledWith({
      kind: 'request-failure',
      message: 'secret detail',
      path: '/api/broken',
    })
  })
})

describe('CompanionServer connection posture', () => {
  it('destroys the 33rd concurrent socket', async () => {
    const { port } = await openServer()
    const sockets: Socket[] = []
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy()
    })
    for (let index = 0; index < 32; index++) sockets.push(await openSocket(port))
    const extra = await openSocket(port)
    sockets.push(extra)
    await new Promise<void>((resolve) => extra.once('close', () => resolve()))
    expect(extra.destroyed).toBe(true)
    expect(sockets.slice(0, 32).every((socket) => !socket.destroyed)).toBe(true)
  })

  it('answers a malformed request line with 400 and closes', async () => {
    const { port } = await openServer()
    const socket = await openSocket(port)
    cleanups.push(() => {
      socket.destroy()
    })
    const received = new Promise<string>((resolve) => {
      let data = ''
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
      })
      socket.once('close', () => resolve(data))
    })
    socket.write('NOT HTTP\r\n\r\n')
    expect(await received).toContain('HTTP/1.1 400 Bad Request')
  })
})

describe('CompanionServer event streams', () => {
  it('writes named frames to an open stream and ends it on close', async () => {
    const { server, port } = await openServer()
    const closed = vi.fn()
    server.router.register('GET', '/api/stream', (context) => {
      const stream = context.openEventStream({ 'x-companion-page': 'page-1' })
      stream.onClose(closed)
      stream.send('snapshot', { revision: 1 })
    })
    const received = await new Promise<{
      headers: Record<string, string | string[] | undefined>
      frames: string
      ended: Promise<void>
    }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/stream',
        headers: bearer(TOKEN),
      })
      request.on('response', (response) => {
        let frames = ''
        const ended = new Promise<void>((done) => response.once('close', () => done()))
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          frames += chunk
          if (frames.includes('event: snapshot'))
            resolve({ headers: response.headers, frames, ended })
        })
      })
      request.on('error', reject)
      request.end()
    })
    expect(received.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(received.headers['x-companion-page']).toBe('page-1')
    expect(received.frames).toContain('retry: 3000\n\n')
    expect(received.frames).toContain('event: snapshot\ndata: {"revision":1}\n\n')
    expect(server.openStreams).toBe(1)
    await server.close()
    await received.ended
    expect(server.listening).toBe(false)
    expect(server.openStreams).toBe(0)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('releases the stream when the client goes away', async () => {
    const { server, port } = await openServer()
    const closed = vi.fn()
    let opened: (() => void) | undefined
    const streamOpened = new Promise<void>((resolve) => {
      opened = resolve
    })
    server.router.register('GET', '/api/stream', (context) => {
      context.openEventStream().onClose(closed)
      opened?.()
    })
    const socket = await openSocket(port)
    socket.write(
      `GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
    )
    await streamOpened
    expect(server.openStreams).toBe(1)
    socket.destroy()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
    expect(server.openStreams).toBe(0)
  })
})

describe('SseWriter', () => {
  it('sends a heartbeat comment every 25 seconds until closed', () => {
    vi.useFakeTimers()
    const { response, writeHead } = fakeResponse()
    let written = ''
    response.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8')
    })
    const writer = new SseWriter(response, { 'x-companion-page': 'p' })
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'content-type': 'text/event-stream; charset=utf-8',
        'x-companion-page': 'p',
      }),
    )
    vi.advanceTimersByTime(25_000)
    vi.advanceTimersByTime(25_000)
    writer.send('snapshot', { a: 1 })
    writer.close()
    vi.advanceTimersByTime(60_000)
    expect(written).toBe(
      'retry: 3000\n\n: heartbeat\n\n: heartbeat\n\nevent: snapshot\ndata: {"a":1}\n\n',
    )
    expect(writer.closed).toBe(true)
    expect(() => writer.send('snapshot', {})).not.toThrow()
  })
})
