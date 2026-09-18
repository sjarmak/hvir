import {
  asSessionsTerminalHandle,
  type ActionableAttentionEntry,
  type TerminalAttentionState,
} from '../../../shared'

export type TerminalAttention = TerminalAttentionState
export type TerminalIdleAttentionState = 'initial' | 'armed' | 'settled'

export interface TerminalOutputAttentionDecision {
  readonly notify: boolean
  readonly scheduleIdle: boolean
}

/** What a terminal shows: its attention and, for a prompt, the message it came with. */
export interface TerminalAttentionSnapshot {
  readonly attention?: TerminalAttention
  readonly promptBody?: string
}

const attentionPriority: Record<TerminalAttention, number> = {
  working: 1,
  bell: 2,
  idle: 3,
  prompt: 4,
}

const ACTIONABLE: readonly TerminalAttention[] = ['idle', 'bell', 'prompt']

export function nextTerminalAttention(
  current: TerminalAttention | undefined,
  incoming: TerminalAttention,
  focused: boolean,
): TerminalAttention | undefined {
  if (focused) return undefined
  if (current && attentionPriority[current] >= attentionPriority[incoming]) {
    return current
  }
  return incoming
}

/**
 * The snapshot after a signal. A prompt carries its latest message: a later
 * notification replaces the body, a lower signal leaves it, and nothing else
 * carries one (ADR-051).
 */
export function terminalAttentionAfterSignal(
  current: TerminalAttentionSnapshot,
  incoming: TerminalAttention,
  body: string | undefined,
  focused: boolean,
): TerminalAttentionSnapshot {
  const attention = nextTerminalAttention(current.attention, incoming, focused)
  if (attention === undefined) return {}
  if (attention !== 'prompt') return { attention }
  const promptBody = incoming === 'prompt' ? body : current.promptBody
  return promptBody === undefined ? { attention } : { attention, promptBody }
}

/**
 * Idle-after-burst represents a completed terminal turn, not terminal startup,
 * resize repaint, or an arbitrary control-sequence write. Enter is the one
 * engine- and harness-independent boundary available at the TerminalPane seam.
 */
export function terminalInputArmsIdleAttention(data: string): boolean {
  return data.includes('\r') || data.includes('\n')
}

export function terminalIdleAttentionAfterInput(
  state: TerminalIdleAttentionState,
  data: string,
): TerminalIdleAttentionState {
  return terminalInputArmsIdleAttention(data) ? 'armed' : state
}

export function terminalOutputAttentionDecision(
  state: TerminalIdleAttentionState,
): TerminalOutputAttentionDecision {
  return {
    notify: state !== 'initial',
    scheduleIdle: state === 'armed',
  }
}

const ATTENTION_LABELS: Record<TerminalAttention, string> = {
  working: 'Working',
  bell: 'Bell',
  idle: 'Ready',
  prompt: 'Prompt',
}

export function terminalAttentionLabel(attention: TerminalAttention): string {
  return ATTENTION_LABELS[attention]
}

export function terminalAttentionBadgeText(attention: TerminalAttention): string {
  return ATTENTION_LABELS[attention].toLowerCase()
}

export function terminalActionableAttentionCount(
  attentions: readonly (TerminalAttention | undefined)[],
): number {
  return attentions.filter(isActionable).length
}

/**
 * The terminals waiting on the person, as the entries main aggregates across
 * windows (ADR-049). Order follows the sessions; a terminal this window shows
 * is always a fresh claim, so no entry here is stale.
 */
export function terminalActionableEntries(
  sessions: readonly ({ readonly id: string } & TerminalAttentionSnapshot)[],
): readonly ActionableAttentionEntry[] {
  const entries: ActionableAttentionEntry[] = []
  for (const session of sessions) {
    if (!isActionable(session.attention)) continue
    entries.push({
      handle: asSessionsTerminalHandle(session.id),
      kind: session.attention === 'idle' ? 'ready' : session.attention,
      freshness: 'fresh',
      ...(session.attention === 'prompt' && session.promptBody !== undefined
        ? { body: session.promptBody }
        : {}),
    })
  }
  return entries
}

/** One string per set of entries, so a rollup republishes only when the set changes. */
export function actionableEntriesFingerprint(
  entries: readonly ActionableAttentionEntry[],
): string {
  return JSON.stringify(entries.map((entry) => [entry.handle, entry.kind, entry.body ?? '']))
}

export function terminalWorkingCount(
  attentions: readonly (TerminalAttention | undefined)[],
): number {
  return attentions.filter((attention) => attention === 'working').length
}

function isActionable(
  attention: TerminalAttention | undefined,
): attention is 'idle' | 'bell' | 'prompt' {
  return attention !== undefined && ACTIONABLE.includes(attention)
}
