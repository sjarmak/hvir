/**
 * Provider-neutral terminal activity shared by recovery and delivery presentation.
 * `prompt` is the terminal's own notification (ADR-051); its message travels
 * beside the state where a surface can show it, never inside it.
 */
export type TerminalAttentionState = 'working' | 'bell' | 'idle' | 'prompt'

const TERMINAL_ATTENTION_STATES: readonly TerminalAttentionState[] = [
  'working',
  'bell',
  'idle',
  'prompt',
]

export function isTerminalAttentionState(value: unknown): value is TerminalAttentionState {
  return TERMINAL_ATTENTION_STATES.some((state) => state === value)
}
