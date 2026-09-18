/**
 * A fake Companion listener behind the page's fetch port: routes, bodies and
 * one event stream the test drives by hand.
 */
import {
  COMPANION_PAGE_HEADER,
  type CompanionFetch,
  type CompanionRequestInit,
  type CompanionResponse,
} from '../src/renderer/companion/src/companion-client'
import {
  SESSIONS_COMPANION_VERSION,
  SESSIONS_TRANSCRIPT_VERSION,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  type CompanionRow,
  type CompanionSnapshot,
  type SessionsMutationResponse,
  type SessionsTranscriptSnapshot,
} from '../src/shared'

export interface FakeCall {
  readonly url: string
  readonly method: string
  readonly authorization?: string
  readonly body?: unknown
}

type Unbranded<T> = Omit<Partial<T>, 'handle'> & { readonly handle: string }

export function row(overrides: Unbranded<CompanionRow>): CompanionRow {
  return {
    title: overrides.handle,
    project: { handle: asSessionsProjectHandle('p1'), name: 'hvir' },
    workspace: {
      handle: asSessionsWorkspaceHandle('w1'),
      name: 'main',
      hostLabel: 'Local',
      hostKind: 'local',
    },
    origin: { kind: 'external-agent', sourceId: 'gas-city', sourceName: 'gas city' },
    attention: { status: 'unsupported' },
    freshness: 'fresh',
    turn: { status: 'unsupported' },
    canAnswer: true,
    canMirror: false,
    ...overrides,
    handle: asSessionsTerminalHandle(overrides.handle),
  }
}

export function snapshot(
  revision: number,
  rows: readonly CompanionRow[],
  demandGeneration = 1,
): CompanionSnapshot {
  return { version: SESSIONS_COMPANION_VERSION, revision, demandGeneration, rows }
}

export function transcript(
  overrides: Unbranded<SessionsTranscriptSnapshot>,
): SessionsTranscriptSnapshot {
  return {
    version: SESSIONS_TRANSCRIPT_VERSION,
    demandGeneration: 1,
    revision: 1,
    status: 'ready',
    stream: 'live',
    turns: [],
    older: false,
    dropped: 0,
    ...overrides,
    handle: asSessionsTerminalHandle(overrides.handle),
  }
}

export class FakeCompanionServer {
  readonly calls: FakeCall[] = []
  token = 'tok-1'
  page = 'page-1'
  pairStatus = 200
  verbStatus = 200
  transcriptReply: SessionsTranscriptSnapshot = transcript({ handle: 'none' })
  mutationReply: SessionsMutationResponse = { outcome: 'accepted' }
  private controller?: ReadableStreamDefaultController<Uint8Array>
  private readonly encoder = new TextEncoder()

  readonly fetch: CompanionFetch = (url, init) => Promise.resolve(this.answer(url, init))

  streams(): number {
    return this.calls.filter((call) => call.url === '/api/events').length
  }

  emit(event: string, data: unknown): void {
    if (!this.controller) throw new Error('no open event stream')
    this.controller.enqueue(
      this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    )
  }

  heartbeat(): void {
    this.controller?.enqueue(this.encoder.encode(': heartbeat\n\n'))
  }

  drop(): void {
    this.controller?.close()
    this.controller = undefined
  }

  private answer(url: string, init: CompanionRequestInit): CompanionResponse {
    this.calls.push({
      url,
      method: init.method,
      authorization: init.headers['authorization'],
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    if (url === '/pair') {
      return this.pairStatus === 200
        ? json(200, { token: this.token })
        : json(this.pairStatus, { error: 'Pairing code rejected' })
    }
    if (init.headers['authorization'] !== `Bearer ${this.token}`) {
      return json(401, { error: 'Unauthorized' })
    }
    if (url === '/api/events') return this.openStream()
    if (this.verbStatus !== 200) return json(this.verbStatus, { error: 'Refused' })
    if (url.endsWith('/select') || url.endsWith('/resume')) {
      return json(200, this.transcriptReply)
    }
    return json(200, this.mutationReply)
  }

  private openStream(): CompanionResponse {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => {
        this.controller = undefined
      },
    })
    return {
      status: 200,
      headers: {
        get: (name) => (name.toLowerCase() === COMPANION_PAGE_HEADER ? this.page : null),
      },
      body: stream,
      json: () => Promise.reject(new Error('event stream')),
    }
  }
}

function json(status: number, body: unknown): CompanionResponse {
  return {
    status,
    headers: { get: () => null },
    body: null,
    json: () => Promise.resolve(body),
  }
}
