/**
 * The only way hvir talks to a gc supervisor over HTTP.
 *
 * The verb surface is exactly what this epic uses, declared once here and generated
 * from the supervisor's own document (ADR-047). Nothing throws at a caller: a
 * supervisor that is off, absent, slow, or refusing produces a named reason a view
 * can render. Provider names never reach a branch in this file; the supervisor's
 * structured format is the one shape hvir reads.
 */
import type { HostId } from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  GASCITY_SUPERVISOR_OPERATIONS,
  type AsyncAcceptedBody,
  type CityInfo,
  type CityPendingEntry,
  type ErrorModel,
  type ListBodyCityPendingEntry,
  type ListBodySessionResponse,
  type SessionPendingResponse,
  type SessionRespondInputBody,
  type SessionRespondOutputBody,
  type SessionSubmitInputBody,
  type SupervisorHealthOutputBody,
} from './generated-supervisor-api'
import type { SessionTranscriptStructuredResponse } from './generated-supervisor-transcript'
import {
  supervisorEndpointFor,
  type SupervisorEndpointDeclaration,
} from './supervisor-endpoint'
import {
  SupervisorStreamDecoder,
  supervisorStreamEvent,
  type SupervisorStreamEvent,
} from './supervisor-stream'
import {
  supervisorRequest,
  supervisorStream,
  type SupervisorConnect,
  type SupervisorHttpResponse,
  type SupervisorTransportFailure,
} from './supervisor-transport'

/** Why the supervisor produced no answer. Each value is renderable on its own. */
export type SupervisorUnavailableReason =
  /** Turned off for this host by configuration. */
  | 'disabled'
  /** The configured endpoint could not be read as one. */
  | 'misconfigured'
  /** Nothing accepted a connection, or the channel died mid-exchange. */
  | 'unreachable'
  | 'timeout'
  /** hvir stopped the exchange. */
  | 'aborted'
  /** The exchange was not valid HTTP, or the body was not the declared shape. */
  | 'protocol'
  /** The city, session, or interaction named does not exist here. */
  | 'not-found'
  /** The supervisor rejected the request as unauthorized. */
  | 'denied'
  /** The session's state does not admit this request. */
  | 'conflict'
  /** The request itself was invalid. */
  | 'rejected'
  /** This supervisor does not implement the verb. */
  | 'unsupported'
  /** The supervisor is up but the city backend is not serving yet. */
  | 'unready'
  | 'faulted'

export interface SupervisorUnavailable {
  readonly reason: SupervisorUnavailableReason
  readonly detail: string
  readonly status?: number
}

export type SupervisorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SupervisorUnavailable }

export interface SupervisorSessionListOptions {
  readonly cursor?: string
  readonly limit?: number
  readonly state?: string
  readonly template?: string
  /** Asks for each session's last output preview. */
  readonly peek?: boolean
}

export interface SupervisorTranscriptOptions {
  /** Return entries after this stable transcript entry ID. */
  readonly after?: string
  /** Return entries before this stable transcript entry ID. */
  readonly before?: string
  /** Number of recent compaction segments. */
  readonly tail?: number
}

export interface SupervisorStreamSubscription {
  /** Releases the request and the channel. Idempotent. */
  close(): void
  /** The resume cursor received so far, for a later `streamSession` call. */
  readonly cursor: string | undefined
}

export interface SupervisorStreamSubscribers {
  readonly onEvent: (event: SupervisorStreamEvent) => void
  /** Reports why the stream ended, unless `close` ended it. */
  readonly onClose: (failure?: SupervisorUnavailable) => void
}

export interface SupervisorClientOptions {
  readonly hostId: HostId
  /** `ProjectHost.connectLoopback`, bound to the host this client speaks for. */
  readonly connect: SupervisorConnect
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_DETAIL_LENGTH = 400

/**
 * Presence is the whole check the supervisor performs on this header; it is not an
 * idempotency key, so a mutation that fails is never retried here (ADR-047).
 */
const ANTI_CSRF_HEADER = 'X-GC-Request'
const ANTI_CSRF_VALUE = 'hvir'

export class GascitySupervisorClient {
  readonly hostId: HostId
  private readonly declaration: SupervisorEndpointDeclaration
  private readonly connect: SupervisorConnect
  private readonly timeoutMs: number

  constructor(options: SupervisorClientOptions) {
    this.hostId = options.hostId
    this.connect = options.connect
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.declaration = supervisorEndpointFor(options.hostId, options.env ?? {})
  }

  /** False when configuration hid the surface, so callers can skip the work. */
  get configured(): boolean {
    return this.declaration.kind === 'endpoint'
  }

  async health(): Promise<SupervisorResult<SupervisorHealthOutputBody>> {
    return await this.read<SupervisorHealthOutputBody>('/health', ['status', 'version'])
  }

  async cities(): Promise<SupervisorResult<readonly CityInfo[]>> {
    const result = await this.read<{ readonly items: readonly CityInfo[] | null }>(
      '/v0/cities',
      ['items'],
    )
    return result.ok ? { ok: true, value: result.value.items ?? [] } : result
  }

  async sessions(
    cityName: string,
    options: SupervisorSessionListOptions = {},
  ): Promise<SupervisorResult<ListBodySessionResponse>> {
    const query = queryString({
      cursor: options.cursor,
      limit: options.limit,
      state: options.state,
      template: options.template,
      peek: options.peek,
    })
    return await this.read<ListBodySessionResponse>(
      `${this.city(cityName)}/sessions${query}`,
      ['items', 'total'],
    )
  }

  /** Every declared pending interaction in the city, for the attention rollup. */
  async cityPending(
    cityName: string,
  ): Promise<SupervisorResult<ListBodyCityPendingEntry>> {
    return await this.read<ListBodyCityPendingEntry>(`${this.city(cityName)}/pending`, [
      'items',
      'total',
    ])
  }

  async sessionPending(
    cityName: string,
    sessionId: string,
  ): Promise<SupervisorResult<SessionPendingResponse>> {
    return await this.read<SessionPendingResponse>(
      `${this.session(cityName, sessionId)}/pending`,
      ['supported'],
    )
  }

  /**
   * Always the structured format, and never with thinking text: a raw transcript
   * would put provider-shaped content inside hvir, which ADR-047 refuses.
   */
  async transcript(
    cityName: string,
    sessionId: string,
    options: SupervisorTranscriptOptions = {},
  ): Promise<SupervisorResult<SessionTranscriptStructuredResponse>> {
    const query = queryString({
      format: 'structured',
      after: options.after,
      before: options.before,
      tail: options.tail,
    })
    const result = await this.read<SessionTranscriptStructuredResponse>(
      `${this.session(cityName, sessionId)}/transcript${query}`,
      ['format', 'schema_version', 'structured_messages'],
    )
    if (result.ok && result.value.format !== 'structured')
      return failure(
        'protocol',
        'Supervisor answered a structured request in another format',
      )
    return result
  }

  /** Answers a declared pending interaction. Never retried (ADR-047). */
  async respond(
    cityName: string,
    sessionId: string,
    body: SessionRespondInputBody,
  ): Promise<SupervisorResult<SessionRespondOutputBody>> {
    return await this.mutate<SessionRespondOutputBody>(
      `${this.session(cityName, sessionId)}/respond`,
      body,
      ['id', 'status'],
    )
  }

  /** Sends a user message to a session. Never retried (ADR-047). */
  async submit(
    cityName: string,
    sessionId: string,
    body: SessionSubmitInputBody,
  ): Promise<SupervisorResult<AsyncAcceptedBody>> {
    return await this.mutate<AsyncAcceptedBody>(
      `${this.session(cityName, sessionId)}/submit`,
      body,
      ['request_id', 'status'],
    )
  }

  /**
   * Opens the session event stream. `afterCursor` resumes where a previous
   * subscription stopped; reconnection is the caller's decision, not a hidden retry.
   */
  async streamSession(
    cityName: string,
    sessionId: string,
    subscribers: SupervisorStreamSubscribers,
    afterCursor?: string,
  ): Promise<SupervisorStreamSubscription> {
    const endpoint = this.endpoint()
    if (!endpoint.ok) {
      subscribers.onClose(endpoint.failure)
      return { close: () => {}, cursor: afterCursor }
    }
    const decoder = new SupervisorStreamDecoder()
    const query = queryString({
      format: 'structured',
      after_cursor: afterCursor,
    })
    let status: number | undefined
    const handle = await supervisorStream(
      this.connect,
      endpoint.value,
      {
        method: 'GET',
        path: `${this.session(cityName, sessionId)}/stream${query}`,
        headers: {
          accept: 'text/event-stream',
          ...(afterCursor === undefined ? {} : { 'Last-Event-ID': afterCursor }),
        },
        timeoutMs: this.timeoutMs,
      },
      {
        onOpen: (code) => {
          status = code
        },
        onChunk: (chunk) => {
          // A non-200 body is an error document, not events; the close reports it.
          if (status !== 200) return
          for (const frame of decoder.push(chunk))
            subscribers.onEvent(supervisorStreamEvent(frame))
        },
        onClose: (transportFailure) => {
          if (status !== undefined && status !== 200) {
            subscribers.onClose(statusFailure(status, ''))
            return
          }
          subscribers.onClose(
            transportFailure === undefined ? undefined : fromTransport(transportFailure),
          )
        },
      },
    )
    return {
      close: () => handle.close(),
      get cursor() {
        return decoder.cursor ?? afterCursor
      },
    }
  }

  private city(cityName: string): string {
    return `/v0/city/${encodeURIComponent(cityName)}`
  }

  private session(cityName: string, sessionId: string): string {
    return `${this.city(cityName)}/session/${encodeURIComponent(sessionId)}`
  }

  private endpoint(): SupervisorResult<
    Extract<SupervisorEndpointDeclaration, { kind: 'endpoint' }>['endpoint']
  > {
    const declaration = this.declaration
    if (declaration.kind === 'endpoint') return { ok: true, value: declaration.endpoint }
    if (declaration.kind === 'disabled')
      return failure('disabled', 'The gas city supervisor is turned off for this host')
    return failure('misconfigured', `${declaration.variable} is not a loopback address`)
  }

  private async read<T>(
    path: string,
    required: readonly string[],
  ): Promise<SupervisorResult<T>> {
    return await this.exchange<T>({ method: 'GET', path }, required)
  }

  private async mutate<T>(
    path: string,
    body: unknown,
    required: readonly string[],
  ): Promise<SupervisorResult<T>> {
    return await this.exchange<T>(
      {
        method: 'POST',
        path,
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          [ANTI_CSRF_HEADER]: ANTI_CSRF_VALUE,
        },
      },
      required,
    )
  }

  private async exchange<T>(
    request: {
      readonly method: 'GET' | 'POST'
      readonly path: string
      readonly body?: string
      readonly headers?: Readonly<Record<string, string>>
    },
    required: readonly string[],
  ): Promise<SupervisorResult<T>> {
    const endpoint = this.endpoint()
    if (!endpoint.ok) return endpoint
    const result = await supervisorRequest(this.connect, endpoint.value, {
      ...request,
      headers: { accept: 'application/json', ...request.headers },
      timeoutMs: this.timeoutMs,
    })
    if (!result.ok) return { ok: false, failure: fromTransport(result.failure) }
    return decode<T>(result.response, required)
  }
}

/**
 * The one place a supervisor channel is opened. Rule 5 of `check-seams.sh` names this
 * module as the owner, so every consumer goes through here rather than dialing a
 * host itself, and local and SSH hosts differ only in what the channel is made of.
 */
export function gascitySupervisorClient(
  host: ProjectHost,
  env?: Readonly<Record<string, string | undefined>>,
): GascitySupervisorClient {
  return new GascitySupervisorClient({
    hostId: host.hostId,
    connect: (endpoint) => host.connectLoopback(endpoint),
    env,
  })
}

/** The request line for every operation this client is allowed to send. */
export const SUPERVISOR_CLIENT_OPERATIONS = GASCITY_SUPERVISOR_OPERATIONS

export type { CityInfo, CityPendingEntry, SupervisorStreamEvent }

function decode<T>(
  response: SupervisorHttpResponse,
  required: readonly string[],
): SupervisorResult<T> {
  if (response.status !== 200 && response.status !== 202)
    return { ok: false, failure: statusFailure(response.status, response.body) }
  let payload: unknown
  try {
    payload = JSON.parse(response.body)
  } catch {
    return failure('protocol', 'Supervisor body is not JSON', response.status)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return failure('protocol', 'Supervisor body is not an object', response.status)
  const missing = required.find((field) => !(field in payload))
  if (missing !== undefined)
    return failure('protocol', `Supervisor body omits ${missing}`, response.status)
  // Structure is checked against the declared operation; the fields stay typed.
  return { ok: true, value: payload as T }
}

function statusFailure(status: number, body: string): SupervisorUnavailable {
  const detail = errorDetail(body) ?? `Supervisor answered ${status}`
  return { reason: reasonForStatus(status), detail, status }
}

function reasonForStatus(status: number): SupervisorUnavailableReason {
  if (status === 401 || status === 403) return 'denied'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 400 || status === 422) return 'rejected'
  if (status === 501) return 'unsupported'
  if (status === 503) return 'unready'
  if (status >= 500) return 'faulted'
  return 'protocol'
}

/** Reads the problem document's own prose, and nothing else from the body. */
function errorDetail(body: string): string | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const problem = payload as Partial<ErrorModel>
  const text = [problem.title, problem.detail].filter((part) => typeof part === 'string')
  if (text.length === 0) return undefined
  return text.join(': ').slice(0, MAX_DETAIL_LENGTH)
}

function fromTransport(
  transportFailure: SupervisorTransportFailure,
): SupervisorUnavailable {
  return { reason: transportFailure.reason, detail: transportFailure.detail }
}

function failure<T>(
  reason: SupervisorUnavailableReason,
  detail: string,
  status?: number,
): SupervisorResult<T> {
  return {
    ok: false,
    failure: { reason, detail, ...(status === undefined ? {} : { status }) },
  }
}

function queryString(
  parameters: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters))
    if (value !== undefined) query.set(key, String(value))
  const text = query.toString()
  return text === '' ? '' : `?${text}`
}
