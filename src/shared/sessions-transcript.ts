/**
 * What a Sessions row's transcript looks like on the wire.
 *
 * The turns are hvir's own projection of a foreign supervisor's structured
 * transcript: ordered, capped, control bytes already stripped, and addressed by
 * an ordinal this projection minted. No foreign session, message, or
 * conversation identifier appears here, because none of them may cross the
 * Sessions boundary (ADR-046); main holds them behind the row's handle.
 */
import type { ProjectState } from './workspace-types'
import type {
  SessionsDemandRequest,
  SessionsOpenRequest,
  SessionsTerminalHandle,
} from './sessions-projection'

export const SESSIONS_TRANSCRIPT_VERSION = 1

/** Turns held for one selected row. A pane shows recent work, not a corpus. */
export const MAX_SESSIONS_TRANSCRIPT_TURNS = 240

/** Per-turn display text. Longer content is cut and marked, never silently. */
export const MAX_SESSIONS_TRANSCRIPT_TEXT = 4_000

/** Who produced the turn, in the supervisor's provider-neutral vocabulary. */
export type SessionsTranscriptTurnRole =
  'user' | 'assistant' | 'system' | 'tool' | 'unknown'

/**
 * What kind of thing the turn is. `event` is a system event the supervisor
 * named; `unknown` is a block this build does not model, kept as a visible gap
 * rather than dropped.
 */
export type SessionsTranscriptTurnKind =
  'text' | 'tool-use' | 'tool-result' | 'interaction' | 'image' | 'event' | 'unknown'

export interface SessionsTranscriptTurn {
  /** Position in this subscription's transcript. Stable while it lives. */
  readonly ordinal: number
  readonly role: SessionsTranscriptTurnRole
  readonly kind: SessionsTranscriptTurnKind
  readonly text: string
  /** The tool the supervisor named, for a tool use or result. */
  readonly toolName?: string
  /** The supervisor's own timestamp, verbatim, when it sent one. */
  readonly at?: string
  /** The turn is still being produced; its text may grow. */
  readonly partial?: boolean
  /** A tool result the supervisor marked as failed. */
  readonly failed?: boolean
  /** Text was cut to the display cap. */
  readonly truncated?: boolean
}

/**
 * Why there is no transcript, or no live stream. Every value renders on its
 * own: ADR-046 requires a stopped supervisor to be distinguishable from stopped
 * agents, which a bare absence cannot do.
 */
export type SessionsTranscriptUnavailableReason =
  /** The handle is not an external session in the current projection. */
  | 'not-projected'
  /** The projection moved on before the request was served. */
  | 'stale-projection'
  /** No city on that host resolved a name the supervisor knows. */
  | 'city-unknown'
  /** The supervisor surface is turned off for that host. */
  | 'disabled'
  /** Its configured endpoint could not be read as one. */
  | 'misconfigured'
  | 'unreachable'
  | 'timeout'
  /** hvir ended the exchange. */
  | 'aborted'
  /** Not valid HTTP, or not the declared shape. */
  | 'protocol'
  | 'not-found'
  | 'denied'
  | 'conflict'
  | 'rejected'
  /** That supervisor does not implement the verb. */
  | 'unsupported'
  /** The supervisor is up; the city backend is not serving yet. */
  | 'unready'
  | 'faulted'

/** Whether turns are still arriving. `lost` is resumed by an explicit request. */
export type SessionsTranscriptStreamState = 'opening' | 'live' | 'lost' | 'closed'

export interface SessionsTranscriptSnapshot {
  readonly version: typeof SESSIONS_TRANSCRIPT_VERSION
  readonly demandGeneration: number
  readonly revision: number
  readonly handle: SessionsTerminalHandle
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** Present when `status` is `unavailable`. */
  readonly reason?: SessionsTranscriptUnavailableReason
  readonly stream: SessionsTranscriptStreamState
  /** Why the stream is not live, when it is not. */
  readonly streamReason?: SessionsTranscriptUnavailableReason
  readonly turns: readonly SessionsTranscriptTurn[]
  /** The supervisor holds older turns this pane did not ask for. */
  readonly older: boolean
  /** Turns dropped off the head to stay inside the cap. */
  readonly dropped: number
}

export interface SessionsTranscriptRequest extends SessionsDemandRequest {
  /** The projection lease this detail hangs off; a detail outlives no list. */
  readonly projectionDemandGeneration: number
  readonly sourceRevision: number
  readonly handle: SessionsTerminalHandle
}

export interface SessionsTranscriptChange {
  readonly demandGeneration: number
  readonly revision: number
  readonly handle: SessionsTerminalHandle
}

/**
 * One renderer-side reference to an external session hvir may attach a terminal
 * to. Opaque on purpose: the foreign identifier behind it stays in main, and a
 * spawn names the attach by redeeming this instead of carrying the identifier.
 */
export type SessionsExternalAttachTicket = string & {
  readonly __sessionsExternalAttachTicket: unique symbol
}

export function asSessionsExternalAttachTicket(
  value: string,
): SessionsExternalAttachTicket {
  return value as SessionsExternalAttachTicket
}

/** Tickets are short lived and renderer scoped; a stale one is refused. */
export const SESSIONS_ATTACH_TICKET_PATTERN = /^[a-f0-9]{32}$/

export function isSessionsExternalAttachTicket(
  value: unknown,
): value is SessionsExternalAttachTicket {
  return typeof value === 'string' && SESSIONS_ATTACH_TICKET_PATTERN.test(value)
}

/**
 * Attach the same way a row is opened: the projection the renderer saw names the
 * row, its project, and its workspace, and main checks all of it before running
 * anything. There is no live PTY qualifier, because the point of attaching is
 * that hvir does not own one yet.
 */
export type SessionsAttachExternalRequest = Omit<SessionsOpenRequest, 'livePty'>

export type SessionsAttachExternalUnavailableReason =
  | 'not-projected'
  | 'stale-projection'
  | 'workspace-unavailable'
  | 'connection-unavailable'

/** Attaching switches the workspace first, exactly as opening a row does. */
export type SessionsAttachExternalResponse =
  | {
      readonly outcome: 'attached'
      readonly state: ProjectState
      readonly handle: SessionsTerminalHandle
      readonly target: SessionsAttachExternalTarget
    }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsAttachExternalUnavailableReason
    }

export interface SessionsAttachExternalTarget {
  /** The command that attaches a shell to the session, as gc addresses it. */
  readonly command: string
  /** Identity for focus-or-launch inside one renderer lifetime. */
  readonly key: string
  readonly ticket: SessionsExternalAttachTicket
}
