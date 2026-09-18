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

const attentionPriority: Record<TerminalAttention, number> = {
  working: 1,
  bell: 2,
  idle: 3,
}

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

export function terminalAttentionLabel(attention: TerminalAttention): string {
  if (attention === 'idle') return 'Ready'
  if (attention === 'bell') return 'Bell'
  return 'Working'
}

export function terminalAttentionBadgeText(attention: TerminalAttention): string {
  if (attention === 'idle') return 'ready'
  if (attention === 'bell') return 'bell'
  return 'working'
}

export function terminalActionableAttentionCount(
  attentions: readonly (TerminalAttention | undefined)[],
): number {
  return attentions.filter((attention) => attention === 'idle' || attention === 'bell')
    .length
}

/**
 * The terminals waiting on the person, as the entries main aggregates across
 * windows (ADR-049). Order follows the sessions; a terminal this window shows
 * is always a fresh claim, so no entry here is stale.
 */
export function terminalActionableEntries(
  sessions: readonly { readonly id: string; readonly attention?: TerminalAttention }[],
): readonly ActionableAttentionEntry[] {
  const entries: ActionableAttentionEntry[] = []
  for (const session of sessions) {
    if (session.attention !== 'idle' && session.attention !== 'bell') continue
    entries.push({
      handle: asSessionsTerminalHandle(session.id),
      kind: session.attention === 'idle' ? 'ready' : 'bell',
      freshness: 'fresh',
    })
  }
  return entries
}

/** One string per set of entries, so a rollup republishes only when the set changes. */
export function actionableEntriesFingerprint(
  entries: readonly ActionableAttentionEntry[],
): string {
  return entries.map((entry) => `${entry.handle}:${entry.kind}`).join('|')
}

export function terminalWorkingCount(
  attentions: readonly (TerminalAttention | undefined)[],
): number {
  return attentions.filter((attention) => attention === 'working').length
}
