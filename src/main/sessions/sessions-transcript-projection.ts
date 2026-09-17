/**
 * The supervisor's structured transcript, folded into what a pane can render.
 *
 * Pure: messages and stream frames in, ordinal-addressed turns out. Two rules
 * decide the shape. Nothing provider-shaped survives the fold, because ADR-047
 * keeps raw and thinking payloads out of hvir entirely, and no foreign
 * identifier survives it, because ADR-046 keeps them out of the projection the
 * renderer sees. What a turn carries is its role, its kind, its text, and the
 * supervisor's own timestamp.
 */
import {
  MAX_SESSIONS_TRANSCRIPT_TEXT,
  MAX_SESSIONS_TRANSCRIPT_TURNS,
  type SessionsTranscriptTurn,
  type SessionsTranscriptTurnKind,
  type SessionsTranscriptTurnRole,
} from '../../shared'
import type { SessionStreamStructuredMessageEvent } from '../gascity/generated-supervisor-api'
import type {
  SessionStructuredBlock,
  SessionStructuredMessage,
  SessionTranscriptStructuredResponse,
} from '../gascity/generated-supervisor-transcript'

/** A turn before it has a position; the fold assigns ordinals at read time. */
type SessionsTranscriptTurnDraft = Omit<SessionsTranscriptTurn, 'ordinal'>

/**
 * One message's turns, held under the message's own identifier so a later
 * upsert can replace it in place. The identifier stays here: it is the join
 * between two supervisor frames, and it never reaches a turn.
 */
interface SessionsTranscriptEntry {
  readonly id: string
  readonly turns: readonly SessionsTranscriptTurnDraft[]
}

export interface SessionsTranscriptFold {
  readonly entries: readonly SessionsTranscriptEntry[]
  /** The supervisor holds older messages this fold did not ask for. */
  readonly older: boolean
  /** Turns dropped off the head to stay inside the cap. */
  readonly dropped: number
  /**
   * The supervisor's own resume position. Carried so a lost socket resumes
   * where the server left off rather than replaying from the beginning.
   */
  readonly cursor?: string
}

export function emptySessionsTranscriptFold(): SessionsTranscriptFold {
  return { entries: [], older: false, dropped: 0 }
}

/** The REST snapshot: whatever the fold held is replaced by what was read. */
export function foldSessionsTranscriptSnapshot(
  response: SessionTranscriptStructuredResponse,
): SessionsTranscriptFold {
  return capped({
    entries: entriesOf(response.structured_messages),
    older: response.pagination?.has_older_messages === true,
    dropped: 0,
    ...cursorOf(response.history.cursor.resume_token),
  })
}

/**
 * One structured stream frame, applied as the server said to apply it. A
 * snapshot or reset replaces the transcript; an upsert merges by message
 * identity, which is the only way a growing assistant turn can be updated
 * rather than duplicated.
 */
export function foldSessionsTranscriptEvent(
  fold: SessionsTranscriptFold,
  event: SessionStreamStructuredMessageEvent,
): SessionsTranscriptFold {
  const cursor = cursorOf(event.history.cursor.resume_token)
  if (event.operation !== 'upsert')
    return capped({
      entries: entriesOf(event.structured_messages),
      older: event.pagination?.has_older_messages === true,
      // A reset replaces the client transcript, so nothing was dropped from
      // the one that now exists.
      dropped: 0,
      ...cursor,
    })
  let entries = fold.entries
  for (const message of event.structured_messages) {
    entries = upsert(entries, message)
  }
  return capped({
    entries,
    older: event.pagination?.has_older_messages === true || fold.older,
    dropped: fold.dropped,
    ...cursor,
  })
}

/** The fold's turns, positioned. The ordinal is a display address, not an id. */
export function sessionsTranscriptTurns(
  fold: SessionsTranscriptFold,
): readonly SessionsTranscriptTurn[] {
  const turns: SessionsTranscriptTurn[] = []
  for (const entry of fold.entries) {
    for (const draft of entry.turns) {
      turns.push({ ordinal: fold.dropped + turns.length, ...draft })
    }
  }
  return turns
}

function upsert(
  entries: readonly SessionsTranscriptEntry[],
  message: SessionStructuredMessage,
): readonly SessionsTranscriptEntry[] {
  const at = entries.findIndex((entry) => entry.id === message.id)
  // A superseded message is one the supervisor has withdrawn: it leaves the
  // transcript rather than sitting under whatever replaced it.
  if (message.status === 'superseded')
    return at === -1 ? entries : [...entries.slice(0, at), ...entries.slice(at + 1)]
  const entry = entryOf(message)
  if (entry === undefined) return entries
  if (at === -1) return [...entries, entry]
  return [...entries.slice(0, at), entry, ...entries.slice(at + 1)]
}

function entriesOf(
  messages: readonly SessionStructuredMessage[],
): readonly SessionsTranscriptEntry[] {
  const entries: SessionsTranscriptEntry[] = []
  for (const message of messages) {
    if (message.status === 'superseded') continue
    const entry = entryOf(message)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/** A message with nothing left to show after the fold is not an entry. */
function entryOf(message: SessionStructuredMessage): SessionsTranscriptEntry | undefined {
  const turns = turnsOf(message)
  return turns.length === 0 ? undefined : { id: message.id, turns }
}

function turnsOf(
  message: SessionStructuredMessage,
): readonly SessionsTranscriptTurnDraft[] {
  const role = roleOf(message.role)
  const partial = message.status === 'partial'
  const at = message.timestamp
  const turns: SessionsTranscriptTurnDraft[] = []
  for (const block of message.blocks) {
    const drafted = blockTurn(block)
    if (drafted === undefined) continue
    turns.push({
      role,
      ...drafted,
      ...(at === undefined ? {} : { at }),
      ...(partial ? { partial: true } : {}),
    })
  }
  const event =
    'system_event' in message ? displayText(message.system_event?.message) : undefined
  if (event !== undefined && event.text !== '')
    turns.push({
      role,
      kind: 'event',
      ...event,
      ...(at === undefined ? {} : { at }),
    })
  return turns
}

type BlockTurn = Omit<SessionsTranscriptTurnDraft, 'role' | 'at' | 'partial'>

/**
 * One block, as a turn. A thinking block yields nothing: hvir does not ask for
 * reasoning payloads and does not display the ones a server volunteers
 * (ADR-047). Anything else with no text left is dropped, so an empty block does
 * not occupy a row.
 */
function blockTurn(block: SessionStructuredBlock): BlockTurn | undefined {
  switch (block.type) {
    case 'thinking':
      return undefined
    case 'text':
      return withText('text', block.text)
    case 'tool_use':
      return named('tool-use', block.name, block.file_path)
    case 'tool_result':
      return {
        ...named('tool-result', block.name, block.content ?? block.file_path),
        ...(block.is_error === true ? { failed: true } : {}),
      }
    case 'interaction':
      return withText(
        'interaction',
        block.interaction?.prompt ?? block.interaction?.action,
      )
    case 'image':
      return withText('image', block.text ?? block.file_path)
    case 'unknown':
      return withText('unknown', block.text ?? block.content)
  }
}

/**
 * A tool turn. The tool's name is the content here, so the turn survives a
 * result whose body is empty or all control bytes.
 */
function named(
  kind: SessionsTranscriptTurnKind,
  name: string | undefined,
  text: string | undefined,
): BlockTurn {
  const cut = displayText(text)
  return {
    kind,
    text: cut?.text ?? '',
    ...(cut?.truncated === true ? { truncated: true } : {}),
    ...(name === undefined || name === '' ? {} : { toolName: name }),
  }
}

function withText(
  kind: SessionsTranscriptTurnKind,
  text: string | undefined,
): BlockTurn | undefined {
  const cut = displayText(text)
  // A block whose only content is control bytes is not a turn.
  if (cut === undefined || cut.text === '') return undefined
  return { kind, ...cut }
}

/** The supervisor's role vocabulary is the projection's, so this is identity. */
function roleOf(role: SessionStructuredMessage['role']): SessionsTranscriptTurnRole {
  return role
}

function cursorOf(token: string): { readonly cursor?: string } {
  return token === '' ? {} : { cursor: token }
}

/**
 * The cap is applied at fold time, not at render time: the transcript of a long
 * running session is unbounded, and a pane that holds all of it holds it for as
 * long as the row is selected. The newest turns are the ones kept, and what
 * left the head is counted so the pane can say so.
 */
function capped(fold: SessionsTranscriptFold): SessionsTranscriptFold {
  let total = 0
  for (const entry of fold.entries) total += entry.turns.length
  if (total <= MAX_SESSIONS_TRANSCRIPT_TURNS) return fold
  const entries: SessionsTranscriptEntry[] = []
  let kept = 0
  for (let index = fold.entries.length - 1; index >= 0; index -= 1) {
    const entry = fold.entries[index]
    if (entry === undefined) continue
    if (kept + entry.turns.length > MAX_SESSIONS_TRANSCRIPT_TURNS) break
    entries.unshift(entry)
    kept += entry.turns.length
  }
  return {
    ...fold,
    entries,
    // The head is gone, so the supervisor holds turns this fold does not,
    // whatever its own pagination said.
    older: true,
    dropped: fold.dropped + (total - kept),
  }
}

/**
 * Display text: control bytes stripped, length capped, and marked when cut.
 *
 * Stripping is for display only, exactly as gc's own dashboard does it. The
 * supervisor's transcript is unchanged; hvir is a reader here and alters
 * nothing upstream.
 */
function displayText(
  value: string | undefined,
): { readonly text: string; readonly truncated?: boolean } | undefined {
  if (value === undefined) return undefined
  const stripped = stripControlBytes(value)
  if (stripped.length <= MAX_SESSIONS_TRANSCRIPT_TEXT) return { text: stripped }
  return { text: stripped.slice(0, MAX_SESSIONS_TRANSCRIPT_TEXT), truncated: true }
}

/** CSI, OSC, and single-character escapes, then the C0 bytes that are not text. */
const ESCAPE_SEQUENCES =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g

// Tab and newline are text; the rest of C0, and DEL, are not.
// eslint-disable-next-line no-control-regex
const CONTROL_BYTES = /[\u0000-\u0008\u000b-\u001f\u007f]/g

function stripControlBytes(value: string): string {
  return value
    .replace(/\r\n|\r/g, '\n')
    .replace(ESCAPE_SEQUENCES, '')
    .replace(CONTROL_BYTES, '')
    .trim()
}
