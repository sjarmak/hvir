import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { bindCompanionApi } from '../src/main/companion/companion-api-routes'
import {
  SSE_MAX_BACKLOG_BYTES,
  SseWriter,
  type SseResponse,
} from '../src/main/companion/companion-http'
import { CompanionRouter } from '../src/main/companion/companion-router'
import { CompanionSessionsService } from '../src/main/companion/companion-sessions'
import { asSessionsTerminalHandle } from '../src/shared'
import { companionWorld, livePty, localRoot } from './companion-sessions-fixture'

const LOCAL = asSessionsTerminalHandle('local-session')

/** An SSE response whose write buffer the test sets by hand. */
function backloggedResponse(): SseResponse & {
  writableLength: number
  readonly written: () => string
} {
  let written = ''
  return {
    writableLength: 0,
    written: () => written,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      written += chunk
      return true
    },
    end: vi.fn(),
    once: vi.fn(),
  }
}

function frames(written: string): string[] {
  return written
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => frame.split('\n')[0]!.replace(/^event: /, ''))
}

function terminalFrames(written: string): unknown[] {
  return written
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: terminal\n'))
    .map((frame): unknown => JSON.parse(frame.split('\n')[1]!.replace(/^data: /, '')))
}

async function streamed() {
  const world = companionWorld()
  world.ptys.set([livePty('local-session', localRoot)])
  let next = 0
  const service = new CompanionSessionsService({
    ...world.ports,
    mintPageId: () => `page-${(next += 1)}`,
  })
  const router = new CompanionRouter()
  bindCompanionApi(router, service)
  const match = router.resolve('GET', '/api/events')
  if (match.kind !== 'matched') throw new Error('no /api/events route')
  const response = backloggedResponse()
  const writer = new SseWriter(response)
  await match.handler({
    request: {} as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL('http://127.0.0.1/api/events'),
    params: match.params,
    openEventStream: () => writer,
  })
  return { world, service, router, response, writer }
}

interface JsonReply {
  readonly status: number
  readonly body: unknown
}

/** Drives one JSON verb through the router as the server would, catching what it throws. */
async function post(
  router: CompanionRouter,
  path: string,
  body: unknown,
): Promise<JsonReply> {
  const match = router.resolve('POST', path)
  if (match.kind !== 'matched') throw new Error(`no route for ${path}`)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const request = Object.assign(Readable.from([payload]), {
    headers: { 'content-length': String(payload.length) },
  }) as unknown as IncomingMessage
  let reply: JsonReply | undefined
  const response = {
    writeHead: (status: number) => {
      reply = { status, body: undefined }
    },
    end: (chunk: Buffer) => {
      reply = { status: reply?.status ?? 0, body: JSON.parse(chunk.toString('utf8')) }
    },
  } as unknown as ServerResponse
  try {
    await match.handler({
      request,
      response,
      url: new URL(`http://127.0.0.1${path}`),
      params: match.params,
      openEventStream: () => {
        throw new Error('not a stream')
      },
    })
  } catch (error) {
    const { status, message } = error as { status?: number; message: string }
    if (status === undefined) throw error
    return { status, body: { error: message } }
  }
  if (reply === undefined) throw new Error(`no reply for ${path}`)
  return reply
}

const RESIZE = `/api/sessions/${LOCAL}/resize`

describe('Companion /api/events terminal frames', () => {
  it('an output frame over the backlog cap ends the mirror with overrun', async () => {
    const { world, service, response, writer } = await streamed()
    service.select('page-1', LOCAL)
    const lease = world.mirrors.leases[0]!
    lease.handlers.onData('fits')
    expect(frames(response.written())).toEqual(['snapshot', 'terminal', 'terminal'])
    expect(response.written()).toContain('"type":"output"')

    response.writableLength = SSE_MAX_BACKLOG_BYTES + 1
    lease.handlers.onData('dropped-secret-bytes')
    expect(response.written()).not.toContain('dropped-secret-bytes')
    expect(response.written()).toContain(
      `event: terminal\ndata: ${JSON.stringify({ type: 'ended', handle: LOCAL, reason: 'overrun' })}`,
    )
    expect(lease.released).toBe(true)
    expect(writer.closed).toBe(false)
    lease.handlers.onData('after the end')
    expect(response.written()).not.toContain('after the end')
    service.dispose()
  })

  it('a terminal frame does not end the stream, and closed still does', async () => {
    const { world, service, response, writer } = await streamed()
    service.select('page-1', LOCAL)
    world.mirrors.leases[0]!.handlers.onGeometry({ cols: 100, rows: 30 })
    world.mirrors.leases[0]!.exit({ exitCode: 1, signal: undefined })
    expect(frames(response.written())).toEqual([
      'snapshot',
      'terminal',
      'terminal',
      'terminal',
    ])
    expect(writer.closed).toBe(false)
    service.closeAll('shutdown')
    expect(frames(response.written()).at(-1)).toBe('closed')
    expect(writer.closed).toBe(true)
    service.dispose()
  })
})

describe('Companion POST resize (ADR-052)', () => {
  it('accepts a bounded size for the mirrored row without the typing permission', async () => {
    const { world, service, router } = await streamed()
    service.select('page-1', LOCAL)
    expect(world.mirrors.typingAllowed).toBe(false)
    const reply = await post(router, RESIZE, { page: 'page-1', cols: 47, rows: 31 })
    expect(reply).toEqual({ status: 200, body: { outcome: 'accepted' } })
    expect(world.mirrors.leases[0]!.resizes).toEqual([{ cols: 47, rows: 31 }])
    expect(world.mirrors.leases[0]!.writes).toEqual([])
    service.dispose()
  })

  it('answers 400 to every body that is not exactly {page, cols, rows} within bounds', async () => {
    const { world, service, router } = await streamed()
    service.select('page-1', LOCAL)
    for (const body of [
      { page: 'page-1' },
      { page: 'page-1', cols: 47 },
      { page: 'page-1', cols: 1, rows: 31 },
      { page: 'page-1', cols: 47, rows: 1001 },
      { page: 'page-1', cols: '47', rows: 31 },
      { page: 'page-1', cols: 47.5, rows: 31 },
      { page: 'page-1', cols: 47, rows: 31, handle: LOCAL },
      { cols: 47, rows: 31 },
    ]) {
      const reply = await post(router, RESIZE, body)
      expect(reply.status, JSON.stringify(body)).toBe(400)
    }
    expect(world.mirrors.leases[0]!.resizes).toEqual([])
    service.dispose()
  })

  it('answers 404 for an unknown page and 409 for a row without a mirror', async () => {
    const { world, service, router } = await streamed()
    expect(await post(router, RESIZE, { page: 'page-9', cols: 47, rows: 31 })).toEqual({
      status: 404,
      body: { error: 'Companion page is not open' },
    })
    expect(await post(router, RESIZE, { page: 'page-1', cols: 47, rows: 31 })).toEqual({
      status: 409,
      body: { error: 'Companion page holds no mirror for this row' },
    })
    expect(world.mirrors.leases).toEqual([])
    service.dispose()
  })

  it('a desktop-focused refusal answers 409 with the reason and keeps the mirror open', async () => {
    const { world, service, router, response } = await streamed()
    service.select('page-1', LOCAL)
    const lease = world.mirrors.leases[0]!
    lease.refuseWrite = 'desktop-focused'
    expect(await post(router, RESIZE, { page: 'page-1', cols: 47, rows: 31 })).toEqual({
      status: 409,
      body: { outcome: 'refused', reason: 'desktop-focused' },
    })
    expect(lease.released).toBe(false)
    expect(
      terminalFrames(response.written()).map((frame) => (frame as { type: string }).type),
    ).toEqual(['opened'])
    lease.handlers.onData('still mirrored')
    expect(response.written()).toContain('still mirrored')
    service.dispose()
  })

  it('a resize on a dead lease answers 409 ended and the stream carries ended exited', async () => {
    const { world, service, router, response } = await streamed()
    service.select('page-1', LOCAL)
    const lease = world.mirrors.leases[0]!
    lease.refuseWrite = 'instance-changed'
    expect(await post(router, RESIZE, { page: 'page-1', cols: 47, rows: 31 })).toEqual({
      status: 409,
      body: { error: 'The mirrored terminal ended or changed' },
    })
    expect(lease.released).toBe(true)
    expect(terminalFrames(response.written()).at(-1)).toEqual({
      type: 'ended',
      handle: LOCAL,
      reason: 'exited',
    })
    expect(await post(router, RESIZE, { page: 'page-1', cols: 47, rows: 31 })).toEqual({
      status: 409,
      body: { error: 'Companion page holds no mirror for this row' },
    })
    service.dispose()
  })
})
