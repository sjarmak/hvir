/**
 * What a host's city event stream has established, folded.
 *
 * Pure: declared events in, per-host facts out. Two things are held. Session
 * lifecycle transitions, as the supervisor reported them, so a session that
 * crashed or was quarantined is a fact hvir holds rather than something a view
 * has to be open to notice. And the city's declared pending interactions, which
 * are the exact attention signal ADR-048 admits.
 *
 * Nothing folded here is inferred. A state hvir has stopped observing is marked
 * with the reason it stopped, because ADR-048 forbids both silently dropping a
 * pending interaction and asserting one nobody is watching.
 */
import type { HostId, HostPath } from '../../shared'
import type { CityPendingEntry } from './generated-supervisor-api'
import type { SupervisorAddressReason } from './supervisor-access'
import type {
  SupervisorCityLifecycleEvent,
  SupervisorCityLifecycleType,
} from './supervisor-stream'

/** One session's last reported transition. */
export interface CitySessionLifecycleFact {
  /**
   * gc's own session identifier, the same value the projection source carries.
   * Main-internal: it is the join between a city event and a projected row, and
   * it never crosses an IPC boundary (ADR-046).
   */
  readonly sessionKey: string
  readonly event: SupervisorCityLifecycleType
  /** The supervisor's own timestamp, verbatim. */
  readonly at: string
  /** The supervisor's sequence for the event, for ordering and resume. */
  readonly seq: number
  /** Whatever the supervisor said about why, when it said anything. */
  readonly reason?: string
}

/** One declared pending interaction, as the city's own list reports it. */
export interface CityPendingFact {
  readonly sessionKey: string
  readonly requestId: string
  /** gc's kind word, verbatim; the consumer decides whether it knows it. */
  readonly kind: string
}

/**
 * Whether the facts are being watched right now. Anything but `live` means the
 * facts are stale and the reason says why; `unavailable` is a stream that never
 * opened, `lost` one that opened and then stopped.
 */
export type CityEventStreamState = 'opening' | 'live' | 'lost' | 'unavailable'

/**
 * Why a stream is not live. The supervisor's own vocabulary plus the clean end,
 * so the reason stays a code every consumer can render: a stale attention badge
 * has to say why it is stale (ADR-048), and free server text is not a reason a
 * surface can be built on.
 */
export type CityEventStreamReason = SupervisorAddressReason | 'closed'

/** One host's city events, with the freshness hvir can honestly claim for them. */
export interface HostCityEvents {
  readonly hostId: HostId
  /** The city root the stream was opened against, when one was known. */
  readonly cityRoot?: HostPath
  readonly stream: CityEventStreamState
  /** Why the stream is not live. Absent only while it is. */
  readonly reason?: CityEventStreamReason
  /** When a live stream last confirmed these facts. */
  readonly observedAt: number
  /** The supervisor sequence an explicit resume would continue from. */
  readonly cursor?: string
  readonly lifecycle: readonly CitySessionLifecycleFact[]
  readonly pending: readonly CityPendingFact[]
}

/**
 * Per-host caps. A city is unbounded and its event stream is host-wide, so the
 * facts kept are the newest ones and the rest are dropped rather than held.
 */
export const MAX_CITY_LIFECYCLE_FACTS = 200
export const MAX_CITY_PENDING_FACTS = 200

/** Long enough to explain a state, short enough not to be a payload. */
const MAX_CITY_EVENT_REASON = 200

export function openingHostCityEvents(
  hostId: HostId,
  cityRoot: HostPath | undefined,
  at: number,
): HostCityEvents {
  return {
    hostId,
    ...(cityRoot === undefined ? {} : { cityRoot }),
    stream: 'opening',
    observedAt: at,
    lifecycle: [],
    pending: [],
  }
}

/** A stream that opened. Its facts are being watched from here until it is not. */
export function liveHostCityEvents(facts: HostCityEvents, at: number): HostCityEvents {
  const { reason: _dropped, ...rest } = facts
  return { ...rest, stream: 'live', observedAt: at }
}

/**
 * A stream that stopped. The facts stay exactly as they were and carry the
 * reason: dropping them would hide a blocked agent, and keeping them without
 * the reason would assert a pending state nobody is watching (ADR-048).
 */
export function lostHostCityEvents(
  facts: HostCityEvents,
  reason: CityEventStreamReason,
): HostCityEvents {
  return { ...facts, stream: 'lost', reason }
}

/** A stream that never opened, with the reason it could not be. */
export function unavailableHostCityEvents(
  facts: HostCityEvents,
  reason: CityEventStreamReason,
): HostCityEvents {
  return { ...facts, stream: 'unavailable', reason }
}

/**
 * One lifecycle event. A session keeps one transition, its latest: the stream is
 * a sequence of transitions and what a consumer needs is where the session ended
 * up. An event that names no session is not a fact about one and is dropped.
 */
export function foldCityLifecycleEvent(
  facts: HostCityEvents,
  event: SupervisorCityLifecycleEvent,
  cursor: string | undefined,
  at: number,
): HostCityEvents {
  const sessionKey = sessionKeyOf(event)
  const next = {
    ...liveHostCityEvents(facts, at),
    ...(cursor === undefined ? {} : { cursor }),
  }
  if (sessionKey === undefined) return next
  const previous = facts.lifecycle.find(
    (candidate) => candidate.sessionKey === sessionKey,
  )
  // An out-of-order arrival does not overwrite a later transition.
  if (previous !== undefined && previous.seq > event.seq) return next
  const fact: CitySessionLifecycleFact = {
    sessionKey,
    event: event.type,
    at: event.ts,
    seq: event.seq,
    ...reasonOf(event),
  }
  return {
    ...next,
    lifecycle: [
      fact,
      ...facts.lifecycle.filter((candidate) => candidate.sessionKey !== sessionKey),
    ].slice(0, MAX_CITY_LIFECYCLE_FACTS),
  }
}

/**
 * The city's declared pending interactions, as one whole list. A read replaces
 * what was held rather than merging into it: the list is the supervisor's own
 * answer, and an interaction missing from it has been resolved.
 */
export function foldCityPending(
  facts: HostCityEvents,
  entries: readonly CityPendingEntry[],
  at: number,
): HostCityEvents {
  return {
    ...liveHostCityEvents(facts, at),
    pending: entries.slice(0, MAX_CITY_PENDING_FACTS).map((entry) => ({
      sessionKey: entry.session_id,
      requestId: entry.request_id,
      kind: entry.kind,
    })),
  }
}

/**
 * One resolved interaction, withdrawn as soon as it is answered. Answering is
 * the response the signal asked for, so the badge clears on the answer rather
 * than on the next read of the city's list (ADR-048).
 */
export function withdrawCityPending(
  facts: HostCityEvents,
  requestId: string,
): HostCityEvents {
  return {
    ...facts,
    pending: facts.pending.filter((entry) => entry.requestId !== requestId),
  }
}

/** Whether these facts are being watched, and so may be asserted as current. */
export function hostCityEventsFresh(facts: HostCityEvents): boolean {
  return facts.stream === 'live'
}

/**
 * The session an event is about. The envelope carries it for every transition;
 * the two that also carry a lifecycle payload repeat it there.
 */
function sessionKeyOf(event: SupervisorCityLifecycleEvent): string | undefined {
  if (typeof event.session_id === 'string' && event.session_id !== '')
    return event.session_id
  const payload: unknown = event.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const declared = (payload as { readonly session_id?: unknown }).session_id
  return typeof declared === 'string' && declared !== '' ? declared : undefined
}

function reasonOf(event: SupervisorCityLifecycleEvent): { readonly reason?: string } {
  const payload: unknown = event.payload
  const declared =
    payload !== null && typeof payload === 'object'
      ? (payload as { readonly reason?: unknown }).reason
      : undefined
  const text = typeof declared === 'string' && declared !== '' ? declared : event.message
  return text === undefined || text === '' ? {} : { reason: capped(text) }
}

function capped(text: string): string {
  return text.length <= MAX_CITY_EVENT_REASON
    ? text
    : `${text.slice(0, MAX_CITY_EVENT_REASON)}…`
}
