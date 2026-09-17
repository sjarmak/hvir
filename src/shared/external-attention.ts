/**
 * Attention raised by an external agent session, on its way to the nav.
 *
 * A declared pending interaction is a person being waited on, so it counts in
 * hvir's own attention rollup exactly as a terminal waiting on you does
 * (ADR-009, ADR-048). The count is placed against the workspace hvir put the
 * session in, so the project tab and the nav aggregate it with no knowledge of
 * where it came from.
 *
 * Nothing here is demand scoped. The facts follow open projects, not the
 * Sessions view, because a blocked worker has to be able to raise attention
 * with that view closed. Nothing here carries a foreign identifier either: a
 * count and, when hvir has stopped watching, the reason why (ADR-046).
 */

export const EXTERNAL_ATTENTION_VERSION = 1

/** One entry per workspace with external attention; a quiet workspace has none. */
export const MAX_EXTERNAL_ATTENTION_ENTRIES = 500

/** An agent cannot be waiting on a person more times than this in one workspace. */
export const MAX_EXTERNAL_ATTENTION_WAITING = 99

/**
 * Why hvir is no longer watching a host's external attention. The supervisor's
 * own vocabulary, plus the clean end of a stream. A stale badge must be able to
 * say why it is stale (ADR-048), so these are codes rather than server text.
 */
export type ExternalAttentionStaleReason =
  | 'disabled'
  | 'misconfigured'
  | 'unreachable'
  | 'timeout'
  | 'aborted'
  | 'protocol'
  | 'not-found'
  | 'denied'
  | 'conflict'
  | 'rejected'
  | 'unsupported'
  | 'unready'
  | 'faulted'
  /** No city on that host resolved a name the supervisor knows. */
  | 'city-unknown'
  /** The stream ended without failing. */
  | 'closed'

/**
 * What one workspace is waiting on. A stale entry is the last thing hvir saw,
 * not a claim about now: ADR-048 forbids dropping the signal and forbids
 * asserting it, so both the count and the reason travel together.
 */
export interface ExternalAttentionEntry {
  readonly workspaceId: string
  readonly waiting: number
  /** Present together, or not at all. */
  readonly stale?: true
  readonly reason?: ExternalAttentionStaleReason
}

export interface ExternalAttentionSnapshot {
  readonly version: typeof EXTERNAL_ATTENTION_VERSION
  /** Main-owned ordering, so a late push cannot overwrite a newer one. */
  readonly revision: number
  readonly entries: readonly ExternalAttentionEntry[]
}

export const EMPTY_EXTERNAL_ATTENTION: ExternalAttentionSnapshot = {
  version: EXTERNAL_ATTENTION_VERSION,
  revision: 0,
  entries: [],
}

export function isExternalAttentionSnapshot(
  value: unknown,
): value is ExternalAttentionSnapshot {
  if (!isRecord(value) || !exactKeys(value, ['version', 'revision', 'entries'])) {
    return false
  }
  return (
    value['version'] === EXTERNAL_ATTENTION_VERSION &&
    isSafeCount(value['revision']) &&
    Array.isArray(value['entries']) &&
    value['entries'].length <= MAX_EXTERNAL_ATTENTION_ENTRIES &&
    value['entries'].every(isExternalAttentionEntry)
  )
}

function isExternalAttentionEntry(value: unknown): value is ExternalAttentionEntry {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ['workspaceId', 'waiting', 'stale', 'reason'].includes(key))) {
    return false
  }
  if (typeof value['workspaceId'] !== 'string' || value['workspaceId'] === '')
    return false
  if (!isSafeCount(value['waiting']) || value['waiting'] > MAX_EXTERNAL_ATTENTION_WAITING)
    return false
  // An entry either claims to be current or says why it is not; a stale entry
  // with no reason would be the silent drop ADR-048 rules out.
  if (value['stale'] === undefined) return value['reason'] === undefined
  return value['stale'] === true && isExternalAttentionStaleReason(value['reason'])
}

export function isExternalAttentionStaleReason(
  value: unknown,
): value is ExternalAttentionStaleReason {
  return (
    typeof value === 'string' &&
    [
      'disabled',
      'misconfigured',
      'unreachable',
      'timeout',
      'aborted',
      'protocol',
      'not-found',
      'denied',
      'conflict',
      'rejected',
      'unsupported',
      'unready',
      'faulted',
      'city-unknown',
      'closed',
    ].includes(value)
  )
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
