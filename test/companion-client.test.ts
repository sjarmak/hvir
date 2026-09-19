import { describe, expect, it, vi } from 'vitest'

import {
  COMPANION_PAGE_HEADER,
  COMPANION_TOKEN_STORAGE_KEY,
  CompanionHttpFailure,
  CompanionUnauthorizedError,
  browserTokenStore,
  createCompanionClient,
  type CompanionClient,
  type CompanionFetch,
  type CompanionRequestInit,
  type CompanionResponse,
  type CompanionTokenStore,
} from '../src/renderer/companion/src/companion-client'
import { SseFrameParser } from '../src/renderer/companion/src/companion-wire'
import {
  SESSIONS_COMPANION_VERSION,
  SESSIONS_TRANSCRIPT_VERSION,
  asSessionsTerminalHandle,
  type CompanionEvent,
  type CompanionSnapshot,
  type SessionsTranscriptSnapshot,
} from '../src/shared'

interface RecordedCall {
  readonly url: string
  readonly init: CompanionRequestInit
}

function memoryTokens(initial?: string): CompanionTokenStore & { token?: string } {
  const store = {
    token: initial,
    read: () => store.token,
    write: (token: string) => {
      store.token = token
    },
    clear: () => {
      store.token = undefined
    },
  }
  return store
}

function jsonResponse(status: number, body: unknown): CompanionResponse {
  return {
    status,
    headers: { get: () => null },
    body: null,
    json: () => Promise.resolve(body),
  }
}

function streamResponse(page: string | undefined): {
  response: CompanionResponse
  push: (text: string) => void
  end: () => void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    response: {
      status: 200,
      headers: {
        get: (name) =>
          name.toLowerCase() === COMPANION_PAGE_HEADER ? (page ?? null) : null,
      },
      body: stream,
      json: () => Promise.reject(new Error('not json')),
    },
    push: (text) => controller?.enqueue(encoder.encode(text)),
    end: () => controller?.close(),
  }
}

const SNAPSHOT: CompanionSnapshot = {
  version: SESSIONS_COMPANION_VERSION,
  revision: 1,
  demandGeneration: 3,
  away: true,
  rows: [],
}

const ROW = asSessionsTerminalHandle('row/1')

const TRANSCRIPT: SessionsTranscriptSnapshot = {
  version: SESSIONS_TRANSCRIPT_VERSION,
  demandGeneration: 3,
  revision: 2,
  handle: asSessionsTerminalHandle('row-1'),
  status: 'ready',
  stream: 'live',
  turns: [],
  older: false,
  dropped: 0,
}

function harness(
  answer: (call: RecordedCall) => CompanionResponse | Promise<CompanionResponse>,
  initialToken?: string,
): { client: CompanionClient; calls: RecordedCall[]; tokens: CompanionTokenStore } {
  const calls: RecordedCall[] = []
  const fetch: CompanionFetch = (url, init) => {
    const call = { url, init }
    calls.push(call)
    return Promise.resolve(answer(call))
  }
  const tokens = memoryTokens(initialToken)
  return { client: createCompanionClient({ fetch, tokens }), calls, tokens }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('companion client', () => {
  it('pairs by posting the code and keeps the token it is handed', async () => {
    const { client, calls, tokens } = harness(() => jsonResponse(200, { token: 'tok-1' }))
    expect(client.paired()).toBe(false)

    await client.pair('ABCD-EFGH')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/pair')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers['content-type']).toBe('application/json')
    expect(calls[0]?.init.headers['authorization']).toBeUndefined()
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ code: 'ABCD-EFGH' })
    expect(tokens.read()).toBe('tok-1')
    expect(client.paired()).toBe(true)
  })

  it('reports a rejected pairing code with its status and keeps no token', async () => {
    const { client, tokens } = harness(() =>
      jsonResponse(401, { error: 'Pairing code rejected' }),
    )
    await expect(client.pair('nope')).rejects.toBeInstanceOf(CompanionHttpFailure)
    await expect(client.pair('nope')).rejects.toMatchObject({ status: 401 })
    expect(tokens.read()).toBeUndefined()
  })

  it('refuses a pairing reply without a token string', async () => {
    const { client } = harness(() => jsonResponse(200, { token: 42 }))
    await expect(client.pair('ABCD')).rejects.toThrow(/token/)
  })

  it('reads a snapshot with the bearer and validates the reply', async () => {
    const { client, calls } = harness(() => jsonResponse(200, SNAPSHOT), 'tok-1')

    const snapshot = await client.snapshot('page-1')

    expect(snapshot).toEqual(SNAPSHOT)
    expect(calls[0]?.url).toBe('/api/sessions?page=page-1')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.headers['authorization']).toBe('Bearer tok-1')
    expect(calls.some((call) => call.url.includes('tok-1'))).toBe(false)
  })

  it('refuses a snapshot reply that is not a CompanionSnapshot', async () => {
    const { client } = harness(
      () => jsonResponse(200, { ...SNAPSHOT, extra: 1 }),
      'tok-1',
    )
    await expect(client.snapshot('page-1')).rejects.toThrow(/snapshot/)
  })

  it('clears the token on 401 and reports the page as unpaired', async () => {
    const { client, tokens } = harness(() => jsonResponse(401, { error: 'no' }), 'tok-1')

    await expect(client.snapshot('page-1')).rejects.toBeInstanceOf(
      CompanionUnauthorizedError,
    )

    expect(tokens.read()).toBeUndefined()
    expect(client.paired()).toBe(false)
  })

  it('refuses every verb before pairing without touching the network', async () => {
    const { client, calls } = harness(() => jsonResponse(200, SNAPSHOT))
    await expect(client.snapshot('page-1')).rejects.toBeInstanceOf(
      CompanionUnauthorizedError,
    )
    await expect(client.openEvents(() => undefined)).rejects.toBeInstanceOf(
      CompanionUnauthorizedError,
    )
    expect(calls).toHaveLength(0)
  })

  it('selects, resumes, answers and messages through the sessions routes', async () => {
    const accepted = { outcome: 'accepted' as const }
    const { client, calls } = harness(
      (call) =>
        jsonResponse(
          200,
          call.url.endsWith('/select') || call.url.endsWith('/resume')
            ? TRANSCRIPT
            : accepted,
        ),
      'tok-1',
    )

    expect(await client.select('page-1', ROW)).toEqual(TRANSCRIPT)
    expect(await client.resume('page-1', ROW)).toEqual(TRANSCRIPT)
    expect(
      await client.respond('page-1', {
        handle: ROW,
        pendingRevision: 4,
        optionOrdinal: 1,
      }),
    ).toEqual(accepted)
    expect(await client.submit('page-1', { handle: ROW, message: 'go' })).toEqual(
      accepted,
    )

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ['/api/sessions/row%2F1/select', 'POST'],
      ['/api/sessions/row%2F1/resume', 'POST'],
      ['/api/sessions/row%2F1/respond', 'POST'],
      ['/api/sessions/row%2F1/message', 'POST'],
    ])
    expect(calls.map((call) => JSON.parse(call.init.body ?? '') as unknown)).toEqual([
      { page: 'page-1' },
      { page: 'page-1' },
      { page: 'page-1', handle: 'row/1', pendingRevision: 4, optionOrdinal: 1 },
      { page: 'page-1', handle: 'row/1', message: 'go' },
    ])
    for (const call of calls) {
      expect(call.init.headers['authorization']).toBe('Bearer tok-1')
    }
  })

  it('input posts exact bytes with the page and reads the mutation outcome', async () => {
    const { client, calls } = harness(
      () => jsonResponse(200, { outcome: 'accepted' }),
      'tok-1',
    )
    const bytes = '\u001b[A\r\ud800'
    expect(await client.input('page-1', ROW, bytes)).toEqual({ outcome: 'accepted' })
    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ['/api/sessions/row%2F1/input', 'POST'],
    ])
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ page: 'page-1', data: bytes })
    expect(calls[0]?.init.headers['authorization']).toBe('Bearer tok-1')
  })

  it('surfaces a refused input with its status', async () => {
    const { client } = harness(
      () => jsonResponse(403, { error: 'Typing from the Companion is off in Settings' }),
      'tok-1',
    )
    await expect(client.input('page-1', ROW, '\r')).rejects.toMatchObject({
      status: 403,
      message: 'Typing from the Companion is off in Settings',
    })
  })

  it('resize posts the grid with the page and reads accepted or the refusal reason (ADR-052)', async () => {
    const accepted = harness(() => jsonResponse(200, { outcome: 'accepted' }), 'tok-1')
    expect(await accepted.client.resize('page-1', ROW, { cols: 47, rows: 31 })).toEqual({
      outcome: 'accepted',
    })
    expect(accepted.calls.map((call) => [call.url, call.init.method])).toEqual([
      ['/api/sessions/row%2F1/resize', 'POST'],
    ])
    expect(JSON.parse(accepted.calls[0]?.init.body ?? '')).toEqual({
      page: 'page-1',
      cols: 47,
      rows: 31,
    })
    expect(accepted.calls[0]?.init.headers['authorization']).toBe('Bearer tok-1')

    const refused = harness(
      () => jsonResponse(409, { outcome: 'refused', reason: 'desktop-focused' }),
      'tok-1',
    )
    expect(await refused.client.resize('page-1', ROW, { cols: 47, rows: 31 })).toEqual({
      outcome: 'refused',
      reason: 'desktop-focused',
    })
  })

  it('a resize answered 409 without a refusal is the ended mirror it says it is', async () => {
    const { client } = harness(
      () => jsonResponse(409, { error: 'The mirrored terminal ended or changed' }),
      'tok-1',
    )
    await expect(
      client.resize('page-1', ROW, { cols: 47, rows: 31 }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'The mirrored terminal ended or changed',
    })
    const malformed = harness(() => jsonResponse(200, { outcome: 'maybe' }), 'tok-1')
    await expect(
      malformed.client.resize('page-1', ROW, { cols: 47, rows: 31 }),
    ).rejects.toThrow(/resize/)
  })

  it('refuses a mutation reply that is not a mutation response', async () => {
    const { client } = harness(() => jsonResponse(200, { outcome: 'maybe' }), 'tok-1')
    await expect(
      client.submit('page-1', {
        handle: asSessionsTerminalHandle('row-1'),
        message: 'go',
      }),
    ).rejects.toThrow(/mutation/)
  })

  it('surfaces a failed verb with the server status and message', async () => {
    const { client } = harness(
      () => jsonResponse(409, { error: 'Companion page has no selection' }),
      'tok-1',
    )
    await expect(
      client.resume('page-1', asSessionsTerminalHandle('row-1')),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Companion page has no selection',
    })
  })

  it('opens the event stream with the bearer and reads the page id from the header', async () => {
    const stream = streamResponse('page-7')
    const { client, calls } = harness(() => stream.response, 'tok-1')
    const events: CompanionEvent[] = []

    const opened = await client.openEvents((event) => events.push(event))

    expect(opened.page).toBe('page-7')
    expect(calls[0]?.url).toBe('/api/events')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.headers['authorization']).toBe('Bearer tok-1')
    expect(calls[0]?.init.headers['accept']).toBe('text/event-stream')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)

    stream.push('retry: 3000\n\n')
    stream.push(': heartbeat\n\n')
    stream.push(`event: snapshot\ndata: ${JSON.stringify(SNAPSHOT)}\n\n`)
    const transcriptFrame = `event: transcript\ndata: ${JSON.stringify(TRANSCRIPT)}\n\n`
    stream.push(transcriptFrame.slice(0, 20))
    stream.push(transcriptFrame.slice(20))
    await tick()

    expect(events).toEqual([
      { type: 'snapshot', snapshot: SNAPSHOT },
      { type: 'transcript', transcript: TRANSCRIPT },
    ])

    stream.push('event: closed\ndata: {"reason":"revoked"}\n\n')
    expect(await opened.done).toEqual({ kind: 'closed', reason: 'revoked' })
    expect(calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('decodes terminal frames and refuses a malformed one', async () => {
    const stream = streamResponse('page-7')
    const { client } = harness(() => stream.response, 'tok-1')
    const events: CompanionEvent[] = []
    const opened = await client.openEvents((event) => events.push(event))

    const output = { type: 'output', handle: 'row-1', data: '\u001b[2J$ ' }
    stream.push(`event: terminal\ndata: ${JSON.stringify(output)}\n\n`)
    await tick()
    expect(events).toEqual([{ type: 'terminal', terminal: output }])

    stream.push('event: terminal\ndata: {"type":"resize","handle":"row-1"}\n\n')
    expect(await opened.done).toMatchObject({ kind: 'protocol' })
    expect(events).toHaveLength(1)
  })

  it('reports a stream the server ended as lost and never reopens it', async () => {
    const stream = streamResponse('page-7')
    const { client, calls } = harness(() => stream.response, 'tok-1')
    const opened = await client.openEvents(() => undefined)

    stream.end()

    expect(await opened.done).toEqual({ kind: 'lost', message: 'The event stream ended' })
    await tick()
    expect(calls).toHaveLength(1)
  })

  it('reports a stream closed by the page as aborted', async () => {
    const stream = streamResponse('page-7')
    const { client, calls } = harness(() => stream.response, 'tok-1')
    const opened = await client.openEvents(() => undefined)

    opened.close()

    expect(await opened.done).toEqual({ kind: 'aborted' })
    expect(calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('ends the stream on a frame it cannot read', async () => {
    const stream = streamResponse('page-7')
    const { client } = harness(() => stream.response, 'tok-1')
    const events: CompanionEvent[] = []
    const opened = await client.openEvents((event) => events.push(event))

    stream.push('event: snapshot\ndata: {"version":9}\n\n')

    expect(await opened.done).toMatchObject({ kind: 'protocol' })
    expect(events).toEqual([])
  })

  it('refuses a stream without a page header or a body', async () => {
    const noPage = streamResponse(undefined)
    const first = harness(() => noPage.response, 'tok-1')
    await expect(first.client.openEvents(() => undefined)).rejects.toThrow(/page/)

    const second = harness(
      () => ({
        status: 200,
        headers: { get: () => 'page-1' },
        body: null,
        json: () => Promise.resolve(undefined),
      }),
      'tok-1',
    )
    await expect(second.client.openEvents(() => undefined)).rejects.toThrow(/body/)
  })

  it('clears the token when the stream answers 401', async () => {
    const { client, tokens } = harness(() => jsonResponse(401, { error: 'no' }), 'tok-1')
    await expect(client.openEvents(() => undefined)).rejects.toBeInstanceOf(
      CompanionUnauthorizedError,
    )
    expect(tokens.read()).toBeUndefined()
  })
})

describe('SSE frame parser', () => {
  it('joins multi-line data, ignores comments and retry hints, and keeps partial frames', () => {
    const parser = new SseFrameParser()
    expect(
      parser.feed(
        ': hello\r\nretry: 5\r\n\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: tail',
      ),
    ).toEqual([{ event: 'a', data: '1\n2' }])
    expect(parser.feed('\n\n')).toEqual([{ event: 'message', data: 'tail' }])
  })
})

describe('browser token store', () => {
  it('reads, writes and clears the token under the versioned key', () => {
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, value),
      removeItem: (key: string) => backing.delete(key),
    }
    const store = browserTokenStore(() => storage)
    expect(store.read()).toBeUndefined()
    store.write('tok')
    expect(backing.get(COMPANION_TOKEN_STORAGE_KEY)).toBe('tok')
    expect(store.read()).toBe('tok')
    store.clear()
    expect(backing.has(COMPANION_TOKEN_STORAGE_KEY)).toBe(false)
  })

  it('treats unavailable storage as no stored token', () => {
    const store = browserTokenStore(() => {
      throw new Error('blocked')
    })
    expect(store.read()).toBeUndefined()
    expect(() => store.write('tok')).not.toThrow()
    expect(() => store.clear()).not.toThrow()
  })

  it('never hands an empty stored value out as a token', () => {
    const storage = {
      getItem: vi.fn(() => ''),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    expect(browserTokenStore(() => storage).read()).toBeUndefined()
  })
})
