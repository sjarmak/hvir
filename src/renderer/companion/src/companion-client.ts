/**
 * The phone page's whole HTTP contract with the loopback listener, in one
 * place. Every verb the page can perform is a method here, the bearer travels
 * only in the Authorization header, and the event stream is read with fetch so
 * that header reaches it too (the browser's native event-source API cannot
 * carry one, and a token in the URL would land in logs).
 */
import type {
  CompanionEvent,
  CompanionResizeRequest,
  CompanionResizeResponse,
  CompanionRespondRequest,
  CompanionSnapshot,
  CompanionSubmitRequest,
  SessionsMutationResponse,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import { isCompanionResizeResponse, isCompanionSnapshot } from '../../../shared'
import {
  CompanionProtocolError,
  SseFrameParser,
  decodeCompanionEvent,
  isSessionsMutationResponse,
  isSessionsTranscriptSnapshot,
} from './companion-wire'

export const COMPANION_TOKEN_STORAGE_KEY = 'hvir-companion:token:v1'
/** Response header on GET /api/events naming the page the stream opened. */
export const COMPANION_PAGE_HEADER = 'x-companion-page'

export interface CompanionRequestInit {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly signal?: AbortSignal
}

export interface CompanionResponse {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: ReadableStream<Uint8Array> | null
  json(): Promise<unknown>
}

export type CompanionFetch = (
  url: string,
  init: CompanionRequestInit,
) => Promise<CompanionResponse>

export interface CompanionTokenStore {
  read(): string | undefined
  write(token: string): void
  clear(): void
}

/** The listener no longer accepts this page's token; it must pair again. */
export class CompanionUnauthorizedError extends Error {
  constructor() {
    super('The Companion pairing is no longer accepted')
    this.name = 'CompanionUnauthorizedError'
  }
}

/** A verb the listener refused, with the status and message it gave. */
export class CompanionHttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CompanionHttpFailure'
  }
}

export type CompanionStreamEnd =
  | { readonly kind: 'closed'; readonly reason: 'revoked' | 'shutdown' | 'lease-lost' }
  | { readonly kind: 'lost'; readonly message: string }
  | { readonly kind: 'protocol'; readonly message: string }
  | { readonly kind: 'aborted' }

/** Events the listener receives; `closed` ends the stream through `done`. */
export type CompanionStreamEvent = Exclude<CompanionEvent, { type: 'closed' }>

export interface CompanionEventStream {
  readonly page: string
  /** Resolves once, when the stream ends. The page decides whether to reopen. */
  readonly done: Promise<CompanionStreamEnd>
  close(): void
}

export interface CompanionClient {
  paired(): boolean
  pair(code: string): Promise<void>
  forget(): void
  openEvents(
    listener: (event: CompanionStreamEvent) => void,
  ): Promise<CompanionEventStream>
  snapshot(page: string): Promise<CompanionSnapshot>
  select(
    page: string,
    handle: SessionsTerminalHandle,
  ): Promise<SessionsTranscriptSnapshot>
  resume(
    page: string,
    handle: SessionsTerminalHandle,
  ): Promise<SessionsTranscriptSnapshot>
  respond(
    page: string,
    request: CompanionRespondRequest,
  ): Promise<SessionsMutationResponse>
  submit(page: string, request: CompanionSubmitRequest): Promise<SessionsMutationResponse>
  /** The user's exact bytes for the mirrored row; nothing is appended. */
  input(
    page: string,
    handle: SessionsTerminalHandle,
    data: string,
  ): Promise<SessionsMutationResponse>
  /**
   * The phone's grid for the mirrored row (ADR-052). A `desktop-focused`
   * refusal is an outcome, not a failure; an ended mirror still throws.
   */
  resize(
    page: string,
    handle: SessionsTerminalHandle,
    request: CompanionResizeRequest,
  ): Promise<CompanionResizeResponse>
}

export interface CompanionClientOptions {
  readonly fetch: CompanionFetch
  readonly tokens: CompanionTokenStore
}

interface AuthorizedRequest {
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** A 409 reply is handed back for the verb to read, not thrown: resize's refusal carries a body. */
  readonly readConflict?: boolean
}

export function createCompanionClient(options: CompanionClientOptions): CompanionClient {
  const { fetch, tokens } = options

  async function authorized(request: AuthorizedRequest): Promise<CompanionResponse> {
    const token = tokens.read()
    if (token === undefined) throw new CompanionUnauthorizedError()
    const withBody = request.body !== undefined
    const headers = {
      ...request.headers,
      authorization: `Bearer ${token}`,
      ...(withBody ? { 'content-type': 'application/json' } : {}),
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      ...(withBody ? { body: JSON.stringify(request.body) } : {}),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (response.status === 401) {
      tokens.clear()
      throw new CompanionUnauthorizedError()
    }
    const conflictRead = request.readConflict === true && response.status === 409
    if (!isSuccess(response.status) && !conflictRead) throw await failure(response)
    return response
  }

  async function post<T>(
    url: string,
    body: unknown,
    accept: (value: unknown) => value is T,
    what: string,
  ): Promise<T> {
    const reply: unknown = await (await authorized({ method: 'POST', url, body })).json()
    if (!accept(reply)) throw new Error(`The listener answered with no ${what}`)
    return reply
  }

  async function pair(code: string): Promise<void> {
    const response = await fetch('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!isSuccess(response.status)) throw await failure(response)
    const reply: unknown = await response.json()
    const token = isRecord(reply) ? reply['token'] : undefined
    if (typeof token !== 'string' || token === '') {
      throw new Error('The pairing reply carried no token')
    }
    tokens.write(token)
  }

  async function openEvents(
    listener: (event: CompanionStreamEvent) => void,
  ): Promise<CompanionEventStream> {
    const controller = new AbortController()
    const response = await authorized({
      method: 'GET',
      url: '/api/events',
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    const page = response.headers.get(COMPANION_PAGE_HEADER)
    if (page === null || page === '') throw new Error('The event stream named no page')
    if (response.body === null) throw new Error('The event stream has no body')
    return {
      page,
      done: pump(response.body, listener, controller),
      close: () => controller.abort(),
    }
  }

  async function snapshot(page: string): Promise<CompanionSnapshot> {
    const url = `/api/sessions?page=${encodeURIComponent(page)}`
    const reply: unknown = await (await authorized({ method: 'GET', url })).json()
    if (!isCompanionSnapshot(reply))
      throw new Error('The listener answered with no snapshot')
    return reply
  }

  /** A 409 is read: the Away door's refusal carries its reason, an ended mirror its error. */
  async function resize(
    page: string,
    handle: SessionsTerminalHandle,
    request: CompanionResizeRequest,
  ): Promise<CompanionResizeResponse> {
    const response = await authorized({
      method: 'POST',
      url: route(handle, 'resize'),
      body: { page, ...request },
      readConflict: true,
    })
    const reply: unknown = await response.json()
    if (isCompanionResizeResponse(reply)) return reply
    if (response.status === 409) throw failureOf(response.status, reply)
    throw new Error('The listener answered with no resize outcome')
  }

  return {
    paired: () => tokens.read() !== undefined,
    pair,
    forget: () => tokens.clear(),
    openEvents,
    snapshot,
    select: (page, handle) =>
      post(route(handle, 'select'), { page }, isSessionsTranscriptSnapshot, 'transcript'),
    resume: (page, handle) =>
      post(route(handle, 'resume'), { page }, isSessionsTranscriptSnapshot, 'transcript'),
    respond: (page, request) =>
      post(
        route(request.handle, 'respond'),
        { page, ...request },
        isSessionsMutationResponse,
        'mutation outcome',
      ),
    submit: (page, request) =>
      post(
        route(request.handle, 'message'),
        { page, ...request },
        isSessionsMutationResponse,
        'mutation outcome',
      ),
    input: (page, handle, data) =>
      post(
        route(handle, 'input'),
        { page, data },
        isSessionsMutationResponse,
        'mutation outcome',
      ),
    resize,
  }
}

function route(handle: string, verb: string): string {
  return `/api/sessions/${encodeURIComponent(handle)}/${verb}`
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function failure(response: CompanionResponse): Promise<CompanionHttpFailure> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A failure without a JSON body keeps the status-only message.
  }
  return failureOf(response.status, body)
}

function failureOf(status: number, body: unknown): CompanionHttpFailure {
  const message =
    isRecord(body) && typeof body['error'] === 'string'
      ? body['error']
      : `The listener answered ${status}`
  return new CompanionHttpFailure(status, message)
}

async function pump(
  body: ReadableStream<Uint8Array>,
  listener: (event: CompanionStreamEvent) => void,
  controller: AbortController,
): Promise<CompanionStreamEnd> {
  const reader = body.getReader()
  controller.signal.addEventListener('abort', () => {
    reader.cancel().catch(() => undefined)
  })
  const decoder = new TextDecoder()
  const parser = new SseFrameParser()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return controller.signal.aborted
          ? { kind: 'aborted' }
          : { kind: 'lost', message: 'The event stream ended' }
      }
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
        const event = decodeCompanionEvent(frame)
        if (event === undefined) continue
        if (event.type === 'closed') {
          controller.abort()
          return { kind: 'closed', reason: event.reason }
        }
        listener(event)
      }
    }
  } catch (error) {
    if (error instanceof CompanionProtocolError) {
      controller.abort()
      return { kind: 'protocol', message: error.message }
    }
    if (controller.signal.aborted) return { kind: 'aborted' }
    return {
      kind: 'lost',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface CompanionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Keeps the token in the browser's storage under a versioned key, with an
 * in-memory copy so a page whose storage is blocked (private mode, cleared
 * site data) still works for its own lifetime and simply pairs again next time.
 */
export function browserTokenStore(
  storage: () => CompanionStorageLike,
): CompanionTokenStore {
  let cached: string | undefined
  return {
    read() {
      if (cached !== undefined) return cached
      try {
        const stored = storage().getItem(COMPANION_TOKEN_STORAGE_KEY)
        cached = stored === null || stored === '' ? undefined : stored
      } catch {
        cached = undefined
      }
      return cached
    },
    write(token) {
      cached = token
      try {
        storage().setItem(COMPANION_TOKEN_STORAGE_KEY, token)
      } catch {
        // Storage is unavailable; the in-memory copy carries this page.
      }
    },
    clear() {
      cached = undefined
      try {
        storage().removeItem(COMPANION_TOKEN_STORAGE_KEY)
      } catch {
        // Nothing stored to clear when storage is unavailable.
      }
    },
  }
}
