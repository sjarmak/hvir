import type { IncomingMessage, ServerResponse } from 'node:http'

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
