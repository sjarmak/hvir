import { readFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect as connectSocket, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GascitySupervisorClient,
  gascitySupervisorClient,
} from '../src/main/gascity/supervisor-client'
import type { ProjectHost } from '../src/main/project-host'
import { GASCITY_SUPERVISOR_OPERATIONS } from '../src/main/gascity/generated-supervisor-api'
import type { SupervisorCityStreamEvent } from '../src/main/gascity/supervisor-stream'
import type { SupervisorConnect } from '../src/main/gascity/supervisor-transport'
import { asHostId, type LoopbackEndpoint } from '../src/shared'

const HOST = asHostId('local')

interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}

type Respond = (request: Recorded, response: ServerResponse) => void

interface Supervisor {
  readonly port: number
  readonly requests: readonly Recorded[]
  stop(): Promise<void>
}

const HEALTH_BODY = {
  status: 'ok',
  version: '1.2.3',
  uptime_sec: 4,
  cities_total: 1,
  cities_running: 1,
} as const

const running: Supervisor[] = []
const channelSets: ChannelSet[] = []

afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.stop()
  for (const channels of channelSets.splice(0)) channels.destroyAll()
})

async function startSupervisor(respond: Respond): Promise<Supervisor> {
  const requests: Recorded[] = []
  const server: Server = createServer((incoming: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.once('end', () => {
      const recorded: Recorded = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers as Readonly<Record<string, string | undefined>>,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(recorded)
      respond(recorded, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const supervisor: Supervisor = {
    port,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  running.push(supervisor)
  return supervisor
}

/** Answers every request with one JSON body, which is all most cases need. */
function jsonSupervisor(status: number, body: unknown): Promise<Supervisor> {
  return startSupervisor((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
}

interface ChannelSet {
  readonly connect: SupervisorConnect
  readonly opened: () => number
  readonly live: () => number
  destroyAll(): void
}

/**
 * A channel with no `Socket` surface, which is what an SSH host hands back. If the
 * client reaches for a socket method, only this flavor notices.
 */
class TunnelChannel extends Duplex {
  constructor(private readonly socket: Socket) {
    super()
    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause()
    })
    socket.once('end', () => this.push(null))
    socket.once('error', (error: Error) => this.destroy(error))
  }

  override _read(): void {
    this.socket.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.socket.write(chunk, done)
  }

  override _final(done: (error?: Error | null) => void): void {
    this.socket.end()
    done()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.socket.destroy()
    done(error)
  }
}

function channelSet(wrap: 'socket' | 'tunnel'): ChannelSet {
  let opened = 0
  const live = new Set<Duplex>()
  const set: ChannelSet = {
    connect: async (endpoint: LoopbackEndpoint) => {
      opened += 1
      const socket = connectSocket(endpoint.port, endpoint.hostname)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      const channel: Duplex = wrap === 'socket' ? socket : new TunnelChannel(socket)
      live.add(channel)
      channel.once('close', () => live.delete(channel))
      return channel
    },
    opened: () => opened,
    live: () => live.size,
    destroyAll: () => {
      for (const channel of live) channel.destroy()
      live.clear()
    },
  }
  channelSets.push(set)
  return set
}

function clientFor(port: number, channels: ChannelSet, timeoutMs = 2_000) {
  return new GascitySupervisorClient({
    hostId: HOST,
    connect: channels.connect,
    env: { HVIR_GASCITY_SUPERVISOR: String(port) },
    timeoutMs,
  })
}

/** Settles after the event loop has drained the channel close callbacks. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('gas city supervisor client', () => {
  it('reaches a local channel and an SSH-shaped channel with the same code path', async () => {
    const supervisor = await jsonSupervisor(200, HEALTH_BODY)
    const answers: unknown[] = []
    for (const flavor of ['socket', 'tunnel'] as const) {
      const channels = channelSet(flavor)
      const result = await clientFor(supervisor.port, channels).health()
      expect(channels.opened()).toBe(1)
      await settled()
      expect(channels.live()).toBe(0)
      answers.push(result)
    }
    expect(answers[0]).toEqual(answers[1])
    expect(answers[0]).toEqual({ ok: true, value: HEALTH_BODY })
  })

  it('sends the declared request line for every read verb', async () => {
    const supervisor = await startSupervisor((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          request.url.includes('/transcript')
            ? {
                format: 'structured',
                id: 'session-1',
                operation: 'snapshot',
                provider: 'claude',
                schema_version: 'session.structured.v1',
                structured_messages: [],
                template: 'agent/worker',
                history: {},
              }
            : { items: [], total: 0, supported: true },
        ),
      )
    })
    const channels = channelSet('tunnel')
    const client = clientFor(supervisor.port, channels)
    expect(await client.cities()).toEqual({ ok: true, value: [] })
    expect((await client.sessions('mem city', { limit: 25, peek: true })).ok).toBe(true)
    expect((await client.cityPending('mem city')).ok).toBe(true)
    expect((await client.sessionPending('mem city', 'w/1')).ok).toBe(true)
    expect((await client.transcript('mem city', 'w/1', { tail: 2 })).ok).toBe(true)
    expect(
      supervisor.requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      'GET /v0/cities',
      'GET /v0/city/mem%20city/sessions?limit=25&peek=true',
      'GET /v0/city/mem%20city/pending',
      'GET /v0/city/mem%20city/session/w%2F1/pending',
      'GET /v0/city/mem%20city/session/w%2F1/transcript?format=structured&tail=2',
    ])
  })

  it('never asks for a raw transcript or for thinking text', async () => {
    const supervisor = await jsonSupervisor(200, {
      format: 'structured',
      schema_version: 'session.structured.v1',
      structured_messages: [],
    })
    const client = clientFor(supervisor.port, channelSet('tunnel'))
    await client.transcript('mem', 'w1', { after: 'entry-4' })
    const query = supervisor.requests[0]?.url ?? ''
    expect(query).toContain('format=structured')
    expect(query).not.toContain('raw')
    expect(query).not.toContain('include_thinking')
  })

  it('refuses a transcript the supervisor answered in another format', async () => {
    const supervisor = await jsonSupervisor(200, {
      format: 'conversation',
      schema_version: 'session.structured.v1',
      structured_messages: [],
    })
    const result = await clientFor(supervisor.port, channelSet('tunnel')).transcript(
      'mem',
      'w1',
    )
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'protocol',
        detail: 'Supervisor answered a structured request in another format',
      },
    })
  })

  it('carries the anti-CSRF header on a mutation and attempts it exactly once', async () => {
    const supervisor = await jsonSupervisor(409, {
      title: 'Conflict',
      detail: 'Session is mid-turn',
    })
    const channels = channelSet('tunnel')
    const client = clientFor(supervisor.port, channels)
    const result = await client.submit('mem', 'w1', { message: 'go' })
    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'conflict',
        detail: 'Conflict: Session is mid-turn',
        status: 409,
      },
    })
    expect(supervisor.requests).toHaveLength(1)
    expect(channels.opened()).toBe(1)
    expect(supervisor.requests[0]?.headers['x-gc-request']).toBe('hvir')
    expect(supervisor.requests[0]?.body).toBe('{"message":"go"}')
    await settled()
    expect(channels.live()).toBe(0)
  })

  it('accepts the 202 each mutation answers with', async () => {
    const supervisor = await startSupervisor((request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          request.url.endsWith('/respond')
            ? { id: 'w1', status: 'delivered' }
            : { request_id: 'r-1', status: 'accepted', event_cursor: '12' },
        ),
      )
    })
    const client = clientFor(supervisor.port, channelSet('tunnel'))
    expect(
      await client.respond('mem', 'w1', { action: 'allow', request_id: 'r-1' }),
    ).toEqual({
      ok: true,
      value: { id: 'w1', status: 'delivered' },
    })
    expect(await client.submit('mem', 'w1', { message: 'go' })).toEqual({
      ok: true,
      value: { request_id: 'r-1', status: 'accepted', event_cursor: '12' },
    })
    expect(supervisor.requests.map((request) => request.url)).toEqual([
      '/v0/city/mem/session/w1/respond',
      '/v0/city/mem/session/w1/submit',
    ])
  })

  it('names each refusal the supervisor can answer with', async () => {
    const cases = [
      [400, 'rejected'],
      [401, 'denied'],
      [403, 'denied'],
      [404, 'not-found'],
      [422, 'rejected'],
      [500, 'faulted'],
      [501, 'unsupported'],
      [503, 'unready'],
    ] as const
    for (const [status, reason] of cases) {
      const supervisor = await jsonSupervisor(status, { title: 'Nope' })
      const result = await clientFor(supervisor.port, channelSet('tunnel')).cities()
      expect(result).toEqual({
        ok: false,
        failure: { reason, detail: 'Nope', status },
      })
      await supervisor.stop()
    }
  })

  it('reports a body that is not the declared shape without throwing', async () => {
    for (const body of ['not json', '[]', '{"total":0}']) {
      const supervisor = await jsonSupervisor(200, body)
      const result = await clientFor(supervisor.port, channelSet('tunnel')).sessions(
        'mem',
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.reason).toBe('protocol')
      await supervisor.stop()
    }
  })

  it('reports an absent supervisor once, with no retry and no held channel', async () => {
    const supervisor = await jsonSupervisor(200, {})
    const port = supervisor.port
    await supervisor.stop()
    const channels = channelSet('tunnel')
    const result = await clientFor(port, channels).health()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.reason).toBe('unreachable')
    expect(channels.opened()).toBe(1)
    expect(channels.live()).toBe(0)
  })

  it('gives up on a silent supervisor and releases the channel', async () => {
    const supervisor = await startSupervisor(() => {
      // Accepts the request and never answers it.
    })
    const channels = channelSet('tunnel')
    const result = await clientFor(supervisor.port, channels, 60).health()
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'timeout', detail: 'Supervisor did not respond' },
    })
    await settled()
    expect(channels.live()).toBe(0)
  })

  it('does not touch the host when configuration hides the surface', async () => {
    for (const [value, reason] of [
      ['off', 'disabled'],
      ['10.0.0.9:8372', 'misconfigured'],
    ] as const) {
      let opened = 0
      const client = new GascitySupervisorClient({
        hostId: HOST,
        connect: () => {
          opened += 1
          return Promise.reject(new Error('unreachable'))
        },
        env: { HVIR_GASCITY_SUPERVISOR: value },
      })
      expect(client.configured).toBe(false)
      const result = await client.health()
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.reason).toBe(reason)
      expect(opened).toBe(0)
    }
  })
})

describe('gas city supervisor client construction', () => {
  it('asks the host for the declared endpoint and nothing else', async () => {
    const supervisor = await jsonSupervisor(200, {
      status: 'ok',
      version: '1',
      uptime_sec: 1,
      cities_total: 0,
      cities_running: 0,
    })
    const channels = channelSet('tunnel')
    const asked: LoopbackEndpoint[] = []
    const host = {
      hostId: HOST,
      connectLoopback: (endpoint: LoopbackEndpoint) => {
        asked.push(endpoint)
        return channels.connect(endpoint)
      },
    } as unknown as ProjectHost
    const client = gascitySupervisorClient(host, {
      HVIR_GASCITY_SUPERVISOR: String(supervisor.port),
    })
    expect(client.hostId).toBe(HOST)
    expect((await client.health()).ok).toBe(true)
    expect(asked).toEqual([{ hostname: '127.0.0.1', port: supervisor.port }])
  })
})

describe('gas city supervisor session stream', () => {
  it('delivers declared events, tracks the cursor, and releases the channel on close', async () => {
    let live: ServerResponse | undefined
    const supervisor = await startSupervisor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('id: cursor-1\nevent: activity\ndata: {"activity":"in-turn"}\n\n')
      live = response
    })
    const channels = channelSet('tunnel')
    const events: string[] = []
    let closedWith: unknown = 'not closed'
    const subscription = await clientFor(supervisor.port, channels).streamSession(
      'mem',
      'w1',
      {
        onEvent: (event) => events.push(event.kind),
        onClose: (failure) => {
          closedWith = failure
        },
      },
    )
    await settled()
    expect(events).toEqual(['activity'])
    expect(subscription.cursor).toBe('cursor-1')
    expect(channels.live()).toBe(1)
    expect(supervisor.requests[0]?.url).toBe(
      '/v0/city/mem/session/w1/stream?format=structured',
    )

    subscription.close()
    await settled()
    // The criterion: no channel survives the abort, and nothing is reported as a fault.
    expect(channels.live()).toBe(0)
    expect(closedWith).toBeUndefined()

    live?.write('event: activity\ndata: {"activity":"idle"}\n\n')
    await settled()
    expect(events).toEqual(['activity'])
    subscription.close()
    expect(channels.live()).toBe(0)
  })

  it('resumes from a cursor the caller carries back', async () => {
    const supervisor = await startSupervisor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: heartbeat\ndata: {"timestamp":"2026-09-17T00:00:00Z"}\n\n')
    })
    const channels = channelSet('tunnel')
    const subscription = await clientFor(supervisor.port, channels).streamSession(
      'mem',
      'w1',
      { onEvent: () => {}, onClose: () => {} },
      'cursor-7',
    )
    await settled()
    expect(supervisor.requests[0]?.url).toBe(
      '/v0/city/mem/session/w1/stream?format=structured&after_cursor=cursor-7',
    )
    expect(supervisor.requests[0]?.headers['last-event-id']).toBe('cursor-7')
    expect(subscription.cursor).toBe('cursor-7')
    subscription.close()
  })

  it('reports a refused stream as a reason, not as events', async () => {
    const supervisor = await jsonSupervisor(404, { title: 'No such session' })
    const channels = channelSet('tunnel')
    const events: string[] = []
    let closedWith: { reason: string } | undefined
    await clientFor(supervisor.port, channels).streamSession('mem', 'w1', {
      onEvent: (event) => events.push(event.kind),
      onClose: (failure) => {
        closedWith = failure
      },
    })
    await settled()
    expect(events).toEqual([])
    expect(closedWith?.reason).toBe('not-found')
    expect(channels.live()).toBe(0)
  })

  it('opens one city event stream and names only the events hvir reports', async () => {
    let live: ServerResponse | undefined
    const supervisor = await startSupervisor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      live = response
      response.write(
        'id: 41\nevent: event\ndata: {"seq":41,"type":"session.crashed","ts":"t","actor":"gc","session_id":"gc-1","payload":{"session_id":"gc-1","reason":"exit 1"}}\n\n',
      )
      response.write('event: heartbeat\ndata: {"timestamp":"t"}\n\n')
      response.write(
        'id: 43\nevent: event\ndata: {"seq":43,"type":"mail.sent","ts":"t","actor":"gc","payload":{}}\n\n',
      )
    })
    const channels = channelSet('socket')
    const events: SupervisorCityStreamEvent[] = []
    const subscription = await clientFor(supervisor.port, channels).streamCity('mem', {
      onEvent: (event) => events.push(event),
      onClose: () => {},
    })
    await settled()

    expect(supervisor.requests[0]?.url).toBe('/v0/city/mem/events/stream')
    expect(events.map((event) => event.kind)).toEqual([
      'lifecycle',
      'heartbeat',
      'unrecognized',
    ])
    const lifecycle = events[0]
    expect(lifecycle?.kind === 'lifecycle' && lifecycle.data.type).toBe('session.crashed')
    // An event type this build does not report says so, and names the type.
    expect(events[2]).toEqual({
      kind: 'unrecognized',
      event: 'mail.sent',
      reason: 'Event type is not reported',
    })
    expect(subscription.cursor).toBe('43')

    subscription.close()
    await settled()
    expect(channels.live()).toBe(0)
    live?.end()
  })

  it('resumes a city stream from a sequence, and never on its own', async () => {
    const supervisor = await startSupervisor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: heartbeat\ndata: {"timestamp":"t"}\n\n')
    })
    const channels = channelSet('tunnel')
    const subscription = await clientFor(supervisor.port, channels).streamCity(
      'mem',
      { onEvent: () => {}, onClose: () => {} },
      '5898675',
    )
    await settled()

    expect(supervisor.requests[0]?.url).toBe(
      '/v0/city/mem/events/stream?after_seq=5898675',
    )
    expect(supervisor.requests[0]?.headers['last-event-id']).toBe('5898675')
    expect(supervisor.requests).toHaveLength(1)
    subscription.close()
  })

  it('reports a stream the supervisor ends, without holding the channel', async () => {
    const supervisor = await startSupervisor((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('event: heartbeat\ndata: {"timestamp":"t"}\n\n')
    })
    const channels = channelSet('tunnel')
    let closedWith: { reason: string } | undefined
    await clientFor(supervisor.port, channels).streamSession('mem', 'w1', {
      onEvent: () => {},
      onClose: (failure) => {
        closedWith = failure
      },
    })
    await settled()
    expect(closedWith).toEqual({
      reason: 'protocol',
      detail: 'Supervisor ended the stream',
    })
    expect(channels.live()).toBe(0)
  })
})

describe('gas city supervisor client provenance', () => {
  it('branches on no provider name', () => {
    const sources = [
      'src/main/gascity/supervisor-client.ts',
      'src/main/gascity/supervisor-transport.ts',
      'src/main/gascity/supervisor-stream.ts',
      'src/main/gascity/supervisor-endpoint.ts',
    ]
    for (const source of sources) {
      const text = readFileSync(new URL(`../${source}`, import.meta.url), 'utf8')
      expect(text).not.toMatch(/\b(claude|codex|gemini|opencode|amp)\b/i)
    }
  })

  it('keeps the generated types regenerable by a documented command', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }
    const command = manifest.scripts['generate:gascity-supervisor-types']
    expect(command).toContain('scripts/generate-gascity-supervisor-types.mts')
    const generated = readFileSync(
      new URL('../src/main/gascity/generated-supervisor-api.ts', import.meta.url),
      'utf8',
    )
    expect(generated).toContain('npm run generate:gascity-supervisor-types')
    expect(generated).toContain('Do not edit it by hand')
  })

  it('exposes exactly the operations this epic declared', () => {
    expect(Object.keys(GASCITY_SUPERVISOR_OPERATIONS).sort()).toEqual([
      'cities',
      'cityEvents',
      'cityPending',
      'health',
      'respond',
      'sessionPending',
      'sessionStream',
      'sessions',
      'submit',
      'transcript',
    ])
  })
})
