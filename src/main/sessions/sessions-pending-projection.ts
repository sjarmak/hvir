/**
 * The interaction a session is waiting on, folded for the pane and back again.
 *
 * Pure. gc addresses an interaction by its own request identifier and names its
 * answers with its own words; neither may cross the Sessions boundary
 * (ADR-046). So the record holds both, the projection publishes positions, and
 * an answer arrives as the position a person clicked. A prompt and its options
 * are server text for a person to read, and go through the same stripping every
 * other supervisor string does.
 */
import {
  MAX_SESSIONS_PENDING_OPTIONS,
  MAX_SESSIONS_PENDING_OPTION_TEXT,
  MAX_SESSIONS_SUBMIT_MESSAGE,
  type SessionsTranscriptPending,
} from '../../shared'
import type { PendingInteraction } from '../gascity/generated-supervisor-api'
import { sessionsTranscriptDisplayText } from './sessions-transcript-projection'

/** One declared interaction, as main holds it. */
export interface SessionsPendingRecord {
  /**
   * Which interaction this is, within one subscription. An answer names it, so
   * a prompt replaced between render and click is refused rather than answered.
   */
  readonly revision: number
  /** gc's own request identifier. Main-internal; never on the wire. */
  readonly requestId: string
  readonly prompt?: string
  /** gc's own option words, in the order it declared them. */
  readonly options: readonly string[]
}

/**
 * The record for one declared interaction, or nothing when what arrived cannot
 * be answered. An interaction with no request identifier is not one hvir can
 * respond to, and an option with no text is not one a person can choose.
 */
export function sessionsPendingRecord(
  interaction: PendingInteraction,
  revision: number,
): SessionsPendingRecord | undefined {
  if (typeof interaction.request_id !== 'string' || interaction.request_id === '') {
    return undefined
  }
  const prompt = sessionsTranscriptDisplayText(interaction.prompt)
  const options: string[] = []
  for (const option of interaction.options ?? []) {
    if (typeof option !== 'string' || option === '') continue
    if (options.length >= MAX_SESSIONS_PENDING_OPTIONS) break
    options.push(option)
  }
  return {
    revision,
    requestId: interaction.request_id,
    ...(prompt === undefined || prompt.text === '' ? {} : { prompt: prompt.text }),
    options,
  }
}

/** What the pane renders: the prompt, and the options by position. */
export function projectSessionsPending(
  record: SessionsPendingRecord,
): SessionsTranscriptPending {
  return {
    revision: record.revision,
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    options: record.options.map((option, ordinal) => ({
      ordinal,
      label:
        sessionsTranscriptDisplayText(option, MAX_SESSIONS_PENDING_OPTION_TEXT)?.text ??
        '',
    })),
  }
}

/**
 * The word gc expects for the option at that position, or nothing when no
 * option stands there. The position is the renderer's whole vocabulary here, so
 * an ordinal it did not receive is refused rather than resolved to a neighbour.
 */
export function sessionsPendingAction(
  record: SessionsPendingRecord,
  ordinal: number,
): string | undefined {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined
  return record.options[ordinal]
}

/**
 * Text a person typed, ready to send, or nothing when it is not sendable. An
 * empty message is not a message, and one over the cap is refused here rather
 * than truncated: sending half of what someone wrote is worse than not sending
 * it.
 */
export function sessionsSubmitMessage(value: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SESSIONS_SUBMIT_MESSAGE) return undefined
  return trimmed
}
