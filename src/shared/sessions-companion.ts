/**
 * What the Companion sees (ADR-049, ADR-050).
 *
 * A Companion page is an away-time observer of the Sessions projection: it
 * reads rows, answers the interaction a row is waiting on, sends a row a
 * message, and mirrors a live hvir terminal. A row is the projection row with
 * everything a phone has no use for stripped, and with the actionable state
 * the badge reports, so the two never disagree. Staleness travels with the row
 * (freshness, reason), and no identifier that belongs to main crosses this
 * boundary: no session key, city root, host id, path, PTY instance, or request
 * id appears here. Terminal bytes cross as the strings the PTY produced and the
 * user typed; nothing here inspects them.
 */
import {
  isActionableAttentionBody,
  type ActionableFreshness,
} from './actionable-attention'
import {
  isExternalAttentionStaleReason,
  type ExternalAttentionStaleReason,
} from './external-attention'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  type SessionsAttentionValue,
  type SessionsFact,
  type SessionsOrigin,
  type SessionsProjectHandle,
  type SessionsReasonCode,
  type SessionsTerminalHandle,
  type SessionsTurnFact,
  type SessionsWorkspaceHandle,
  type SessionsWorkspaceProjection,
} from './sessions-projection'
import {
  MAX_SESSIONS_SUBMIT_MESSAGE,
  type SessionsTranscriptRespondRequest,
  type SessionsTranscriptSnapshot,
  type SessionsTranscriptSubmitRequest,
} from './sessions-transcript'
import { isTerminalReadBackNavigation } from './terminal-wheel'

/**
 * The snapshot's shape, compared for strict equality so a page on an older bundle
 * stops rather than reads a snapshot it misunderstands. It moves only when an
 * existing snapshot field changes shape or meaning. A purely additive optional
 * field is exempt in both directions: the page's guard accepts its absence, so
 * bumping would strand every page that is otherwise fine. Terminal events are not
 * covered by it at all, since it rides the snapshot alone; their compatibility rule
 * is the event guard itself, which ignores an unknown event name and refuses a
 * known name with a shape it does not recognise.
 */
export const SESSIONS_COMPANION_VERSION = 1

/** A page shows what the projection shows; it never grows past it. */
export const MAX_COMPANION_ROWS = MAX_SESSIONS_PROJECTION_ROWS
/** The retained output a mirror opens with; the PTY supervisor's tail bound. */
export const MAX_COMPANION_TERMINAL_TAIL_CHARS = 256 * 1024
/**
 * The sticky-mode preamble a mirror opens with: the width of the scanner's full
 * emission, stated here as the wire's own bound and pinned against
 * `STICKY_MODE_PREAMBLE_MAX_CHARS` by contract test, the way the tail bound is
 * pinned against the supervisor's (ADR-054). It grew with the mouse tracking
 * family (ADR-056), and a page built against the old bound refuses an opened
 * event that carries the new one rather than opening the mirror imperfectly.
 */
export const MAX_COMPANION_TERMINAL_PREAMBLE_CHARS = 54
/** One input request carries at most this many characters of the user's bytes. */
export const MAX_COMPANION_INPUT_CHARS = 4096
/** A resize request names a grid within the PTY's own dimension bounds (ADR-052). */
export const MIN_COMPANION_RESIZE_DIMENSION = 2
export const MAX_COMPANION_RESIZE_DIMENSION = 1000

export interface CompanionRow {
  readonly handle: SessionsTerminalHandle
  readonly title: string
  readonly project: {
    readonly handle: SessionsProjectHandle
    readonly name: string
  }
  readonly workspace: {
    readonly handle: SessionsWorkspaceHandle
    readonly name: string
    /** The host's display label only; its id stays in main. */
    readonly hostLabel: string
    readonly hostKind: SessionsWorkspaceProjection['host']['kind']
  }
  readonly origin: SessionsOrigin
  /**
   * What the actionable set says this row is waiting on. Derived from the same
   * set that drives the badge, so a page and a badge cannot disagree. A row the
   * set does not name reports `unsupported`: nobody is watching it for the
   * Companion, and the Companion does not infer.
   */
  readonly attention: SessionsFact<SessionsAttentionValue>
  /** The prompt's message, bounded; present only when the set carried one (ADR-051). */
  readonly promptBody?: string
  /** Whether the attention above is current or the last thing hvir saw. */
  readonly freshness: ActionableFreshness
  /** Why the attention is stale. Present exactly when `freshness` is `stale`. */
  readonly reason?: ExternalAttentionStaleReason
  /** A window shows this terminal working: output on a row nobody is looking at. */
  readonly working: boolean
  readonly turn: SessionsFact<SessionsTurnFact>
  /** The row stands for a session that takes answers and messages. */
  readonly canAnswer: boolean
  /** The row is a live hvir terminal on a connected host, so a page may mirror it. */
  readonly canMirror: boolean
}

export interface CompanionSnapshot {
  readonly version: typeof SESSIONS_COMPANION_VERSION
  /** Bumped when the rows change; the page's own counter, not the source's. */
  readonly revision: number
  /** The observation lease this page holds. */
  readonly demandGeneration: number
  /**
   * No hvir window is focused (ADR-049). While true a mirror may hold the
   * PTY's size (ADR-052); the page asks only then, and the desktop's door is
   * the authority either way.
   */
  readonly away: boolean
  /** Ordered by {@link compareCompanionRows}. */
  readonly rows: readonly CompanionRow[]
}

/** Why a page was closed from main's side. */
export type CompanionClosedReason = 'revoked' | 'shutdown' | 'lease-lost'

/** Why a page's mirror ended; a page shows a sentence for it, never the code. */
export type CompanionMirrorEndReason =
  'exited' | 'released' | 'reselected' | 'page-closed' | CompanionClosedReason | 'overrun'

/** One page's mirror of a live terminal (ADR-050); every variant names its row. */
export type CompanionTerminalEvent =
  | {
      readonly type: 'opened'
      readonly handle: SessionsTerminalHandle
      readonly cols: number
      readonly rows: number
      /**
       * The sticky terminal modes this tail no longer carries, as the sets that
       * reach them (ADR-054). A page writes it before the tail and never inside
       * it: the tail saturates at its own bound and a prefix would push it past.
       * Absent when the tail still carries the transitions itself, which is every
       * ordinary shell, and which is how a page built before this field existed
       * keeps opening such a mirror unchanged.
       */
      readonly preamble?: string
      /** Retained output at open; live bytes follow as `output`. */
      readonly tail: string
    }
  | {
      readonly type: 'output'
      readonly handle: SessionsTerminalHandle
      readonly data: string
    }
  | {
      readonly type: 'geometry'
      readonly handle: SessionsTerminalHandle
      readonly cols: number
      readonly rows: number
    }
  | {
      readonly type: 'ended'
      readonly handle: SessionsTerminalHandle
      readonly reason: CompanionMirrorEndReason
    }

export type CompanionEvent =
  | { readonly type: 'snapshot'; readonly snapshot: CompanionSnapshot }
  | { readonly type: 'transcript'; readonly transcript: SessionsTranscriptSnapshot }
  | { readonly type: 'terminal'; readonly terminal: CompanionTerminalEvent }
  | { readonly type: 'closed'; readonly reason: CompanionClosedReason }

/** The user's exact bytes for the mirrored terminal: uncomposed, unappended. */
export interface CompanionInputRequest {
  readonly data: string
  /**
   * The bytes are read-back navigation rather than typing (ADR-055): the
   * owner's permission still gates them, the per-mirror arm does not, and they
   * are not recorded as terminal input. The claim is bounded here rather than
   * trusted: it is admitted only for the closed set the shared wheel policy
   * emits for a read-back gesture, the page keys of ADR-055 and the wheel
   * reports of ADR-056.
   */
  readonly navigation?: true
}

/** The phone's own grid, asked for the mirrored PTY while the desktop is Away (ADR-052). */
export interface CompanionResizeRequest {
  readonly cols: number
  readonly rows: number
}

/**
 * How a resize was answered. `refused` is the Away door saying no because a
 * desktop window is focused; the mirror stays open and the page keeps the
 * desktop's geometry. A dead lease is not a refusal but an ended mirror.
 */
export type CompanionResizeResponse =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'refused'; readonly reason: 'desktop-focused' }

/** An answer, as a page sends it: the page's lease supplies the generation. */
export type CompanionRespondRequest = Omit<
  SessionsTranscriptRespondRequest,
  'demandGeneration'
>

/** A message, as a page sends it: the page's lease supplies the generation. */
export type CompanionSubmitRequest = Omit<
  SessionsTranscriptSubmitRequest,
  'demandGeneration'
>

/**
 * Rows the person can act on come first, current before stale; the rest sort
 * the way the Sessions panel does, so a page reads like the panel it mirrors.
 */
export function compareCompanionRows(left: CompanionRow, right: CompanionRow): number {
  return (
    rowGroup(left) - rowGroup(right) ||
    left.project.name.localeCompare(right.project.name) ||
    left.workspace.name.localeCompare(right.workspace.name) ||
    left.title.localeCompare(right.title) ||
    left.handle.localeCompare(right.handle)
  )
}

/**
 * A stale row is one the actionable set still holds, so it is actionable by
 * construction; a fresh row is actionable only when its attention says so.
 */
function rowGroup(row: CompanionRow): number {
  if (row.freshness === 'stale') return 1
  const { attention } = row
  const actionable =
    (attention.status === 'available' || attention.status === 'stale') &&
    attention.value !== 'none'
  return actionable ? 0 : 2
}

export function isCompanionSnapshot(value: unknown): value is CompanionSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return false
  if (value['version'] !== SESSIONS_COMPANION_VERSION) return false
  if (!isCount(value['revision']) || !isGeneration(value['demandGeneration'])) {
    return false
  }
  if (typeof value['away'] !== 'boolean') return false
  const rows = value['rows']
  if (!Array.isArray(rows) || rows.length > MAX_COMPANION_ROWS) return false
  if (!rows.every(isCompanionRow)) return false
  return new Set(rows.map((row) => row.handle)).size === rows.length
}

export function isCompanionRow(value: unknown): value is CompanionRow {
  if (!isRecord(value) || !hasKeys(value, ROW_REQUIRED_KEYS, ROW_OPTIONAL_KEYS)) {
    return false
  }
  return (
    isHandle(value['handle']) &&
    typeof value['title'] === 'string' &&
    isProject(value['project']) &&
    isWorkspace(value['workspace']) &&
    isOrigin(value['origin']) &&
    isFact(value['attention'], isAttentionValue) &&
    isPromptBodyFor(value['promptBody'], value['attention']) &&
    isStaleness(value['freshness'], value['reason']) &&
    typeof value['working'] === 'boolean' &&
    isFact(value['turn'], isTurn) &&
    typeof value['canAnswer'] === 'boolean' &&
    typeof value['canMirror'] === 'boolean'
  )
}

export function isCompanionTerminalEvent(
  value: unknown,
): value is CompanionTerminalEvent {
  if (!isRecord(value) || !isHandle(value['handle'])) return false
  switch (value['type']) {
    case 'opened':
      return (
        hasKeys(value, OPENED_KEYS, OPENED_OPTIONAL_KEYS) &&
        isDimension(value['cols']) &&
        isDimension(value['rows']) &&
        isPreamble(value['preamble']) &&
        typeof value['tail'] === 'string' &&
        value['tail'].length <= MAX_COMPANION_TERMINAL_TAIL_CHARS
      )
    case 'output':
      return hasExactKeys(value, OUTPUT_KEYS) && typeof value['data'] === 'string'
    case 'geometry':
      return (
        hasExactKeys(value, GEOMETRY_KEYS) &&
        isDimension(value['cols']) &&
        isDimension(value['rows'])
      )
    case 'ended':
      return (
        hasExactKeys(value, ENDED_KEYS) &&
        MIRROR_END_REASONS.some((reason) => reason === value['reason'])
      )
    default:
      return false
  }
}

export function isCompanionInputRequest(value: unknown): value is CompanionInputRequest {
  if (!isRecord(value) || !hasKeys(value, INPUT_KEYS, INPUT_OPTIONAL_KEYS)) return false
  const data = value['data']
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length > MAX_COMPANION_INPUT_CHARS
  ) {
    return false
  }
  const navigation = value['navigation']
  return (
    navigation === undefined ||
    (navigation === true && isTerminalReadBackNavigation(data))
  )
}

export function isCompanionResizeRequest(
  value: unknown,
): value is CompanionResizeRequest {
  if (!isRecord(value) || !hasExactKeys(value, RESIZE_KEYS)) return false
  return isResizeDimension(value['cols']) && isResizeDimension(value['rows'])
}

export function isCompanionResizeResponse(
  value: unknown,
): value is CompanionResizeResponse {
  if (!isRecord(value)) return false
  if (value['outcome'] === 'accepted') return hasExactKeys(value, ['outcome'])
  return (
    value['outcome'] === 'refused' &&
    hasExactKeys(value, ['outcome', 'reason']) &&
    value['reason'] === 'desktop-focused'
  )
}

export function isCompanionRespondRequest(
  value: unknown,
): value is CompanionRespondRequest {
  if (!isRecord(value) || !hasKeys(value, RESPOND_KEYS, ['text'])) return false
  return (
    isHandle(value['handle']) &&
    isCount(value['pendingRevision']) &&
    isCount(value['optionOrdinal']) &&
    (value['text'] === undefined || isMessageText(value['text']))
  )
}

export function isCompanionSubmitRequest(
  value: unknown,
): value is CompanionSubmitRequest {
  if (!isRecord(value) || !hasExactKeys(value, SUBMIT_KEYS)) return false
  return isHandle(value['handle']) && isMessageText(value['message'])
}

const SNAPSHOT_KEYS = ['version', 'revision', 'demandGeneration', 'away', 'rows'] as const
const ROW_REQUIRED_KEYS = [
  'handle',
  'title',
  'project',
  'workspace',
  'origin',
  'attention',
  'freshness',
  'working',
  'turn',
  'canAnswer',
  'canMirror',
] as const
const ROW_OPTIONAL_KEYS = ['reason', 'promptBody'] as const
const RESPOND_KEYS = ['handle', 'pendingRevision', 'optionOrdinal'] as const
const SUBMIT_KEYS = ['handle', 'message'] as const
const INPUT_KEYS = ['data'] as const
const INPUT_OPTIONAL_KEYS = ['navigation'] as const
const RESIZE_KEYS = ['cols', 'rows'] as const
const OPENED_KEYS = ['type', 'handle', 'cols', 'rows', 'tail'] as const
const OPENED_OPTIONAL_KEYS = ['preamble'] as const
const OUTPUT_KEYS = ['type', 'handle', 'data'] as const
const GEOMETRY_KEYS = ['type', 'handle', 'cols', 'rows'] as const
const ENDED_KEYS = ['type', 'handle', 'reason'] as const
const MIRROR_END_REASONS: readonly CompanionMirrorEndReason[] = [
  'exited',
  'released',
  'reselected',
  'page-closed',
  'revoked',
  'shutdown',
  'lease-lost',
  'overrun',
]
const ATTENTION_VALUES: readonly SessionsAttentionValue[] = [
  'none',
  'ready',
  'bell',
  'prompt',
]
const TURN_STATES: readonly SessionsTurnFact['state'][] = [
  'working',
  'waiting-for-user',
  'waiting-for-approval',
  'idle',
]
const HOST_KINDS: readonly SessionsWorkspaceProjection['host']['kind'][] = [
  'local',
  'ssh',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasKeys(value, keys, [])
}

function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const present = Object.keys(value)
  return (
    required.every((key) => present.includes(key)) &&
    present.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isGeneration(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isDimension(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isResizeDimension(value: unknown): value is number {
  return (
    isDimension(value) &&
    value >= MIN_COMPANION_RESIZE_DIMENSION &&
    value <= MAX_COMPANION_RESIZE_DIMENSION
  )
}

/** Absent is a stream that set no sticky mode; present is bounded by the scanner. */
function isPreamble(value: unknown): boolean {
  if (value === undefined) return true
  return (
    typeof value === 'string' && value.length <= MAX_COMPANION_TERMINAL_PREAMBLE_CHARS
  )
}

function isHandle(value: unknown): value is SessionsTerminalHandle {
  return typeof value === 'string' && value.length > 0
}

function isMessageText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SESSIONS_SUBMIT_MESSAGE
}

function isProject(value: unknown): value is CompanionRow['project'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['handle', 'name']) &&
    isHandle(value['handle']) &&
    typeof value['name'] === 'string'
  )
}

function isWorkspace(value: unknown): value is CompanionRow['workspace'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['handle', 'name', 'hostLabel', 'hostKind']) &&
    isHandle(value['handle']) &&
    typeof value['name'] === 'string' &&
    typeof value['hostLabel'] === 'string' &&
    HOST_KINDS.some((kind) => kind === value['hostKind'])
  )
}

function isOrigin(value: unknown): value is SessionsOrigin {
  if (!isRecord(value)) return false
  if (value['kind'] === 'hvir-terminal') return hasExactKeys(value, ['kind'])
  return (
    value['kind'] === 'external-agent' &&
    hasExactKeys(value, ['kind', 'sourceId', 'sourceName']) &&
    value['sourceId'] === 'gas-city' &&
    typeof value['sourceName'] === 'string'
  )
}

function isAttentionValue(value: unknown): value is SessionsAttentionValue {
  return ATTENTION_VALUES.some((candidate) => candidate === value)
}

function isTurn(value: unknown): value is SessionsTurnFact {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['state']) &&
    TURN_STATES.some((state) => state === value['state'])
  )
}

/** Only a row whose attention is an available prompt carries the message (ADR-051). */
function isPromptBodyFor(
  promptBody: unknown,
  attention: SessionsFact<SessionsAttentionValue>,
): boolean {
  if (promptBody === undefined) return true
  return (
    attention.status === 'available' &&
    attention.value === 'prompt' &&
    isActionableAttentionBody(promptBody)
  )
}

function isStaleness(freshness: unknown, reason: unknown): boolean {
  if (freshness === 'fresh') return reason === undefined
  return freshness === 'stale' && isExternalAttentionStaleReason(reason)
}

function isReasonCode(value: unknown): value is SessionsReasonCode {
  return typeof value === 'string' && value.length > 0
}

function isFact<T>(
  value: unknown,
  isValue: (candidate: unknown) => candidate is T,
): value is SessionsFact<T> {
  if (!isRecord(value)) return false
  switch (value['status']) {
    case 'unsupported':
      return hasExactKeys(value, ['status'])
    case 'pending':
    case 'unavailable':
      return hasExactKeys(value, ['status', 'reason']) && isReasonCode(value['reason'])
    case 'stale':
      return (
        hasExactKeys(value, ['status', 'value', 'observedAt', 'reason']) &&
        isValue(value['value']) &&
        isCount(value['observedAt']) &&
        isReasonCode(value['reason'])
      )
    case 'available':
      return (
        hasKeys(value, ['status', 'value'], ['observedAt']) &&
        isValue(value['value']) &&
        (value['observedAt'] === undefined || isCount(value['observedAt']))
      )
    default:
      return false
  }
}
