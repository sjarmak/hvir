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
  type SessionsTerminalHandle,
} from './sessions-projection'

export const ACTIONABLE_ATTENTION_VERSION = 1

/** A window cannot present more sessions than the projection may hold. */
export const MAX_ACTIONABLE_ENTRIES = MAX_SESSIONS_PROJECTION_ROWS

/** Why a session wants a person: it finished a turn, or it rang the bell. */
export type ActionableKind = 'ready' | 'bell'

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
  if (!keys.every((key) => ['handle', 'kind', 'freshness', 'reason'].includes(key))) {
    return false
  }
  if (typeof value['handle'] !== 'string' || value['handle'] === '') return false
  if (value['kind'] !== 'ready' && value['kind'] !== 'bell') return false
  // Fresh entries carry no reason; a stale entry must say why (ADR-048).
  if (value['freshness'] === 'fresh') return value['reason'] === undefined
  return value['freshness'] === 'stale' && isExternalAttentionStaleReason(value['reason'])
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
