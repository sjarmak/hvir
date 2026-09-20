/**
 * The Companion page's side of the wire: SSE framing and the structural checks
 * that turn a frame into a typed event. Everything the listener sends is
 * external data to this page; a frame that does not fit its declared shape is
 * a protocol failure, never a guess.
 */
import {
  SESSIONS_TRANSCRIPT_VERSION,
  SESSIONS_TRANSCRIPT_STREAM_STATES,
  SESSIONS_TRANSCRIPT_STATUSES,
  SESSIONS_MUTATION_UNAVAILABLE_REASONS,
  SESSIONS_TRANSCRIPT_UNAVAILABLE_REASONS,
  SESSIONS_TRANSCRIPT_TURN_KINDS,
  SESSIONS_TRANSCRIPT_TURN_ROLES,
  isCompanionSnapshot,
  isCompanionTerminalEvent,
  type CompanionClosedReason,
  type CompanionEvent,
  type SessionsMutationResponse,
  type SessionsTranscriptPending,
  type SessionsTranscriptSnapshot,
  type SessionsTranscriptTurn,
} from '../../../shared'

export interface SseFrame {
  readonly event: string
  readonly data: string
}

/** Thrown when a frame names a known event but does not carry its shape. */
export class CompanionProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanionProtocolError'
  }
}

/** Splits a byte-decoded text stream into SSE frames, keeping partial input. */
export class SseFrameParser {
  private buffer = ''

  feed(chunk: string): SseFrame[] {
    this.buffer = (this.buffer + chunk).replaceAll('\r\n', '\n')
    const frames: SseFrame[] = []
    let end = this.buffer.indexOf('\n\n')
    while (end !== -1) {
      const frame = parseFrame(this.buffer.slice(0, end))
      if (frame !== undefined) frames.push(frame)
      this.buffer = this.buffer.slice(end + 2)
      end = this.buffer.indexOf('\n\n')
    }
    return frames
  }
}

function parseFrame(block: string): SseFrame | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const raw = separator === -1 ? '' : line.slice(separator + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return data.length === 0 ? undefined : { event, data: data.join('\n') }
}

/**
 * Reads one frame as a Companion event. Unknown event names are ignored so a
 * newer listener can add events without breaking an older page; a known name
 * with the wrong shape is refused.
 */
export function decodeCompanionEvent(frame: SseFrame): CompanionEvent | undefined {
  if (!EVENT_NAMES.includes(frame.event)) return undefined
  const data = parseJson(frame.event, frame.data)
  if (frame.event === 'snapshot') {
    if (!isCompanionSnapshot(data)) {
      throw new CompanionProtocolError('Unreadable snapshot event')
    }
    return { type: 'snapshot', snapshot: data }
  }
  if (frame.event === 'transcript') {
    if (!isSessionsTranscriptSnapshot(data)) {
      throw new CompanionProtocolError('Unreadable transcript event')
    }
    return { type: 'transcript', transcript: data }
  }
  if (frame.event === 'terminal') {
    if (!isCompanionTerminalEvent(data)) {
      throw new CompanionProtocolError('Unreadable terminal event')
    }
    return { type: 'terminal', terminal: data }
  }
  if (!isRecord(data) || !isClosedReason(data['reason'])) {
    throw new CompanionProtocolError('Unreadable closed event')
  }
  return { type: 'closed', reason: data['reason'] }
}

function parseJson(event: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new CompanionProtocolError(`Event ${event} did not carry JSON`)
  }
}

const EVENT_NAMES: readonly string[] = ['snapshot', 'transcript', 'terminal', 'closed']
const CLOSED_REASONS: readonly string[] = ['revoked', 'shutdown', 'lease-lost']
const TRANSCRIPT_KEYS = new Set([
  'version',
  'demandGeneration',
  'revision',
  'handle',
  'status',
  'reason',
  'stream',
  'streamReason',
  'turns',
  'older',
  'dropped',
  'pending',
])
const TURN_KEYS = new Set([
  'ordinal',
  'role',
  'kind',
  'text',
  'toolName',
  'at',
  'partial',
  'failed',
  'truncated',
])
const PENDING_KEYS = new Set(['revision', 'prompt', 'options'])
const OPTION_KEYS = new Set(['ordinal', 'label'])

function isClosedReason(value: unknown): value is CompanionClosedReason {
  return typeof value === 'string' && CLOSED_REASONS.includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isOneOf(value: unknown, words: readonly string[]): boolean {
  return typeof value === 'string' && words.includes(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isOptionalReason(value: unknown): boolean {
  return value === undefined || isOneOf(value, SESSIONS_TRANSCRIPT_UNAVAILABLE_REASONS)
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

export function isSessionsTranscriptSnapshot(
  value: unknown,
): value is SessionsTranscriptSnapshot {
  if (!isRecord(value) || !onlyKeys(value, TRANSCRIPT_KEYS)) return false
  if (value['version'] !== SESSIONS_TRANSCRIPT_VERSION) return false
  if (!isCount(value['demandGeneration']) || !isCount(value['revision'])) return false
  if (typeof value['handle'] !== 'string' || value['handle'] === '') return false
  if (!isOneOf(value['status'], SESSIONS_TRANSCRIPT_STATUSES)) return false
  if (!isOneOf(value['stream'], SESSIONS_TRANSCRIPT_STREAM_STATES)) return false
  if (!isOptionalReason(value['reason']) || !isOptionalReason(value['streamReason'])) {
    return false
  }
  const turns = value['turns']
  if (!Array.isArray(turns) || !turns.every(isTranscriptTurn)) return false
  if (typeof value['older'] !== 'boolean' || !isCount(value['dropped'])) return false
  return value['pending'] === undefined || isTranscriptPending(value['pending'])
}

function isTranscriptTurn(value: unknown): value is SessionsTranscriptTurn {
  if (!isRecord(value) || !onlyKeys(value, TURN_KEYS)) return false
  return (
    isCount(value['ordinal']) &&
    isOneOf(value['role'], SESSIONS_TRANSCRIPT_TURN_ROLES) &&
    isOneOf(value['kind'], SESSIONS_TRANSCRIPT_TURN_KINDS) &&
    typeof value['text'] === 'string' &&
    isOptionalString(value['toolName']) &&
    isOptionalString(value['at']) &&
    isOptionalBoolean(value['partial']) &&
    isOptionalBoolean(value['failed']) &&
    isOptionalBoolean(value['truncated'])
  )
}

function isTranscriptPending(value: unknown): value is SessionsTranscriptPending {
  if (!isRecord(value) || !onlyKeys(value, PENDING_KEYS)) return false
  if (!isCount(value['revision']) || !isOptionalString(value['prompt'])) return false
  const options = value['options']
  return Array.isArray(options) && options.every(isPendingOption)
}

function isPendingOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, OPTION_KEYS) &&
    isCount(value['ordinal']) &&
    typeof value['label'] === 'string'
  )
}

export function isSessionsMutationResponse(
  value: unknown,
): value is SessionsMutationResponse {
  if (!isRecord(value)) return false
  if (value['outcome'] === 'accepted') return onlyKeys(value, new Set(['outcome']))
  return (
    value['outcome'] === 'unavailable' &&
    onlyKeys(value, new Set(['outcome', 'reason'])) &&
    isOneOf(value['reason'], SESSIONS_MUTATION_UNAVAILABLE_REASONS)
  )
}
