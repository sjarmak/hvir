/**
 * What a window says is waiting on the person, on its way to main.
 *
 * ADR-049 puts one actionable set behind the OS badge, the Companion and Push.
 * The renderer keeps its classification (a terminal is Ready or rang the bell)
 * and hands main the entries, not a count: main has to know which sessions are
 * waiting to dedupe them across windows and to let an away-time observer name
 * them. An entry is a projection handle, never a foreign identifier.
 */

import type { ExternalAttentionStaleReason } from './external-attention'
import { isExternalAttentionStaleReason } from './external-attention'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  sessionsProjectionOptionalText,
  type SessionsTerminalHandle,
} from './sessions-projection'

export const ACTIONABLE_ATTENTION_VERSION = 1

/** A window cannot present more sessions than the projection may hold. */
export const MAX_ACTIONABLE_ENTRIES = MAX_SESSIONS_PROJECTION_ROWS

/**
 * The one short line a prompt's message is bounded to (ADR-051), at every
 * boundary it crosses and in the Push line that carries it.
 */
export const MAX_ACTIONABLE_BODY_CHARS = 120

/**
 * Why a session wants a person: it finished a turn, it rang the bell, or it
 * notified with a message of its own (ADR-051).
 */
export type ActionableKind = 'ready' | 'bell' | 'prompt'

/** The first line of a message, scrubbed and bounded; nothing when that leaves nothing. */
export function actionableAttentionBody(value: string): string | undefined {
  return sessionsProjectionOptionalText(value.split(/\r?\n/, 1)[0], MAX_ACTIONABLE_BODY_CHARS)
}

export function isActionableAttentionBody(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ACTIONABLE_BODY_CHARS
  )
}

/**
 * Whether the entry is a current claim or the last thing seen. A renderer's
 * own terminals are always fresh; staleness enters from an external authority
 * hvir has stopped watching (ADR-048).
 */
export type ActionableFreshness = 'fresh' | 'stale'

export interface ActionableAttentionEntry {
  readonly handle: SessionsTerminalHandle
  readonly kind: ActionableKind
  readonly freshness: ActionableFreshness
  /** Present exactly when the entry is stale. */
  readonly reason?: ExternalAttentionStaleReason
  /** The notification's message; only a prompt carries one (ADR-051). */
  readonly body?: string
}

export interface RendererAttentionSet {
  readonly version: typeof ACTIONABLE_ATTENTION_VERSION
  readonly entries: readonly ActionableAttentionEntry[]
}

export const EMPTY_RENDERER_ATTENTION_SET: RendererAttentionSet = {
  version: ACTIONABLE_ATTENTION_VERSION,
  entries: [],
}

export function isRendererAttentionSet(value: unknown): value is RendererAttentionSet {
  if (!isRecord(value) || !exactKeys(value, ['version', 'entries'])) return false
  if (value['version'] !== ACTIONABLE_ATTENTION_VERSION) return false
  const entries = value['entries']
  if (!Array.isArray(entries) || entries.length > MAX_ACTIONABLE_ENTRIES) return false
  const handles = new Set<string>()
  for (const entry of entries) {
    if (!isActionableAttentionEntry(entry) || handles.has(entry.handle)) return false
    handles.add(entry.handle)
  }
  return true
}

function isActionableAttentionEntry(value: unknown): value is ActionableAttentionEntry {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ENTRY_KEYS.includes(key))) return false
  if (typeof value['handle'] !== 'string' || value['handle'] === '') return false
  if (!ACTIONABLE_KINDS.some((kind) => kind === value['kind'])) return false
  // Only a prompt has a message, and one that says nothing is not carried.
  if (value['body'] !== undefined) {
    if (value['kind'] !== 'prompt' || !isActionableAttentionBody(value['body'])) return false
  }
  // Fresh entries carry no reason; a stale entry must say why (ADR-048).
  if (value['freshness'] === 'fresh') return value['reason'] === undefined
  return value['freshness'] === 'stale' && isExternalAttentionStaleReason(value['reason'])
}

const ENTRY_KEYS = ['handle', 'kind', 'freshness', 'reason', 'body']
const ACTIONABLE_KINDS: readonly ActionableKind[] = ['ready', 'bell', 'prompt']

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
