/**
 * Server-sent event decoding for the supervisor's streams.
 *
 * Pure: bytes in, declared events out. The transport owns the socket; this module
 * owns the wire format and the vocabulary, so both can be tested without either.
 * Two vocabularies share the decoder: a session's own stream, named by its frame
 * name, and a city's event stream, whose frames are all called `event` and are
 * named by the `type` inside them.
 */
import type {
  HeartbeatEvent,
  PendingInteraction,
  SessionActivityEvent,
  SessionPendingClearedEvent,
  SessionStreamMessageEvent,
  SessionStreamStructuredMessageEvent,
  TypedEventStreamEnvelopeSessionCrashed,
  TypedEventStreamEnvelopeSessionIdleKilled,
  TypedEventStreamEnvelopeSessionQuarantined,
  TypedEventStreamEnvelopeSessionStopped,
  TypedEventStreamEnvelopeSessionSuspended,
  TypedEventStreamEnvelopeSessionWoke,
} from './generated-supervisor-api'

/** One dispatched SSE block, before the event name means anything. */
export interface SupervisorStreamFrame {
  /** Defaults to `message` per the SSE specification when the server omits it. */
  readonly event: string
  readonly data: string
  /** The resume cursor, when the server sent one. Carried as `Last-Event-ID`. */
  readonly lastEventId?: string
}

/**
 * The events this epic declares. `raw` transcript frames are deliberately absent:
 * ADR-047 keeps provider-shaped payloads out of hvir, so the client never asks for
 * them, and an arriving one is reported as unrecognized rather than parsed.
 */
export type SupervisorStreamEvent =
  | { readonly kind: 'structured'; readonly data: SessionStreamStructuredMessageEvent }
  | { readonly kind: 'turn'; readonly data: SessionStreamMessageEvent }
  | { readonly kind: 'activity'; readonly data: SessionActivityEvent }
  | { readonly kind: 'pending'; readonly data: PendingInteraction }
  | { readonly kind: 'pending-cleared'; readonly data: SessionPendingClearedEvent }
  | { readonly kind: 'heartbeat'; readonly data: HeartbeatEvent }
  /** A named event or payload this build does not model. Recorded, never thrown. */
  | { readonly kind: 'unrecognized'; readonly event: string; readonly reason: string }

type DeclaredKind = Exclude<SupervisorStreamEvent['kind'], 'unrecognized'>

const EVENT_KINDS: Readonly<Record<string, DeclaredKind | undefined>> = {
  structured: 'structured',
  turn: 'turn',
  activity: 'activity',
  pending: 'pending',
  pending_cleared: 'pending-cleared',
  heartbeat: 'heartbeat',
}

/** A stream that outlives any one socket, so the decoder holds the split-line state. */
export class SupervisorStreamDecoder {
  private pending = ''
  private event: string | undefined
  private data: string[] = []
  private eventId: string | undefined
  private lastEventId: string | undefined

  /**
   * The cursor to resume from. Survives `reset`, because a dropped socket must not
   * cost the position the server already acknowledged.
   */
  get cursor(): string | undefined {
    return this.lastEventId
  }

  /** Discards a half-received block after a socket drop; keeps the cursor. */
  reset(): void {
    this.pending = ''
    this.clearBlock()
  }

  /** Every complete block in this chunk. A trailing partial line is held back. */
  push(chunk: string): readonly SupervisorStreamFrame[] {
    // A CRLF pair must not dispatch twice, and a lone CR is also a line ending.
    const text = (this.pending + chunk).replace(/\r\n|\r/g, '\n')
    const lines = text.split('\n')
    this.pending = lines.pop() ?? ''
    const frames: SupervisorStreamFrame[] = []
    for (const line of lines) {
      const frame = this.consume(line)
      if (frame) frames.push(frame)
    }
    return frames
  }

  private consume(line: string): SupervisorStreamFrame | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return undefined // A comment; keep-alive padding.
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const raw = separator === -1 ? '' : line.slice(separator + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
    // A null in an id is specified to be ignored, not to clear the cursor.
    else if (field === 'id' && !value.includes('\0')) this.eventId = value
    return undefined
  }

  private dispatch(): SupervisorStreamFrame | undefined {
    if (this.data.length === 0) {
      // A block with an id but no data still moves the cursor.
      if (this.eventId !== undefined) this.lastEventId = this.eventId
      this.clearBlock()
      return undefined
    }
    if (this.eventId !== undefined) this.lastEventId = this.eventId
    const frame: SupervisorStreamFrame = {
      event: this.event ?? 'message',
      data: this.data.join('\n'),
      ...(this.lastEventId === undefined ? {} : { lastEventId: this.lastEventId }),
    }
    this.clearBlock()
    return frame
  }

  private clearBlock(): void {
    this.event = undefined
    this.data = []
    this.eventId = undefined
  }
}

/**
 * Names the frame against the declared vocabulary. Unknown names and unparseable
 * payloads become `unrecognized`, so one odd frame cannot end a live stream.
 */
export function supervisorStreamEvent(
  frame: SupervisorStreamFrame,
): SupervisorStreamEvent {
  const kind = EVENT_KINDS[frame.event]
  if (kind === undefined)
    return {
      kind: 'unrecognized',
      event: frame.event,
      reason: 'Event name is not declared by this build',
    }
  const payload = parsedObject(frame)
  if ('reason' in payload) return { kind: 'unrecognized', ...payload }
  const required = REQUIRED_FIELDS[kind]
  const missing = required.find((field) => !(field in payload.value))
  if (missing !== undefined)
    return {
      kind: 'unrecognized',
      event: frame.event,
      reason: `Payload omits ${missing}`,
    }
  // Structural shape is checked; field-level narrowing stays with the consumer.
  return { kind, data: payload.value } as unknown as SupervisorStreamEvent
}

/**
 * The fields a consumer cannot work without. Deliberately shallow: the supervisor
 * may add fields, and a stricter gate here would reject a compatible server.
 */
const REQUIRED_FIELDS: Readonly<Record<DeclaredKind, readonly string[]>> = {
  structured: ['format', 'operation', 'schema_version', 'structured_messages'],
  turn: ['format', 'id', 'turns'],
  activity: ['activity'],
  pending: ['kind', 'request_id'],
  'pending-cleared': ['request_id'],
  heartbeat: ['timestamp'],
}

/**
 * The city events hvir reports: the session lifecycle transitions a person would
 * want to know about without having the view open. The city stream carries far
 * more than this — mail, beads, storage, workflow, supervisor administration —
 * and every other type is reported as unrecognized rather than modelled.
 */
export const SUPERVISOR_CITY_LIFECYCLE_TYPES = [
  'session.crashed',
  'session.stopped',
  'session.suspended',
  'session.woke',
  'session.idle_killed',
  'session.quarantined',
] as const

export type SupervisorCityLifecycleType = (typeof SUPERVISOR_CITY_LIFECYCLE_TYPES)[number]

export type SupervisorCityLifecycleEvent =
  | TypedEventStreamEnvelopeSessionCrashed
  | TypedEventStreamEnvelopeSessionStopped
  | TypedEventStreamEnvelopeSessionSuspended
  | TypedEventStreamEnvelopeSessionWoke
  | TypedEventStreamEnvelopeSessionIdleKilled
  | TypedEventStreamEnvelopeSessionQuarantined

/**
 * One named city frame. Transcript content cannot appear here at all: the city
 * stream carries no message payloads, which is why a host-wide subscription is
 * affordable in the first place (ADR-046).
 */
export type SupervisorCityStreamEvent =
  | { readonly kind: 'lifecycle'; readonly data: SupervisorCityLifecycleEvent }
  | { readonly kind: 'heartbeat'; readonly data: HeartbeatEvent }
  /** A frame name or event type this build does not model. Recorded, never thrown. */
  | { readonly kind: 'unrecognized'; readonly event: string; readonly reason: string }

/** The fields a lifecycle consumer cannot work without; deliberately shallow. */
const CITY_LIFECYCLE_FIELDS = ['seq', 'type', 'ts', 'payload'] as const

/**
 * Names a city frame against the declared vocabulary. The frame name only
 * separates events from keep-alives; which event it is comes from `type` in the
 * payload, so an undeclared type is unrecognized with the type named.
 */
export function supervisorCityStreamEvent(
  frame: SupervisorStreamFrame,
): SupervisorCityStreamEvent {
  if (frame.event !== 'event' && frame.event !== 'heartbeat')
    return {
      kind: 'unrecognized',
      event: frame.event,
      reason: 'Event name is not declared by this build',
    }
  const payload = parsedObject(frame)
  if ('reason' in payload) return { kind: 'unrecognized', ...payload }
  if (frame.event === 'heartbeat') {
    if (!('timestamp' in payload.value))
      return {
        kind: 'unrecognized',
        event: frame.event,
        reason: 'Payload omits timestamp',
      }
    return { kind: 'heartbeat', data: payload.value as unknown as HeartbeatEvent }
  }
  const type = payload.value['type']
  if (typeof type !== 'string')
    return { kind: 'unrecognized', event: frame.event, reason: 'Payload omits type' }
  if (!(SUPERVISOR_CITY_LIFECYCLE_TYPES as readonly string[]).includes(type))
    return { kind: 'unrecognized', event: type, reason: 'Event type is not reported' }
  const missing = CITY_LIFECYCLE_FIELDS.find((field) => !(field in payload.value))
  if (missing !== undefined)
    return { kind: 'unrecognized', event: type, reason: `Payload omits ${missing}` }
  // Structural shape is checked; field-level narrowing stays with the consumer.
  return {
    kind: 'lifecycle',
    data: payload.value as unknown as SupervisorCityLifecycleEvent,
  }
}

/** The frame's data as a JSON object, or the reason it is not one. */
function parsedObject(
  frame: SupervisorStreamFrame,
):
  | { readonly value: Readonly<Record<string, unknown>> }
  | { readonly event: string; readonly reason: string } {
  let payload: unknown
  try {
    payload = JSON.parse(frame.data)
  } catch {
    return { event: frame.event, reason: 'Payload is not JSON' }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return { event: frame.event, reason: 'Payload is not an object' }
  return { value: payload as Readonly<Record<string, unknown>> }
}
