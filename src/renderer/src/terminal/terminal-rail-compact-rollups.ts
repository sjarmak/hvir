import type { TerminalAttention } from './terminal-attention'

export type CompactRollupState = 'prompt' | 'idle' | 'bell'

/** One actionable state's count in the collapsed rail, with the words it is read by. */
export interface CompactAttentionRollup {
  readonly state: CompactRollupState
  readonly letter: string
  readonly count: number
  /** The rollup's own label, such as "2 terminal prompts". */
  readonly label: string
  /** Its part of the strip summary, such as "2 prompts". */
  readonly summary: string
}

/** Prompt outranks Ready and Bell (ADR-051), so it is read first. */
const ROLLUP_STATES: readonly CompactRollupState[] = ['prompt', 'idle', 'bell']

const ROLLUP_LETTERS: Record<CompactRollupState, string> = {
  prompt: 'P',
  idle: 'R',
  bell: 'B',
}

export function compactAttentionRollups(
  attentions: readonly (TerminalAttention | undefined)[],
): readonly CompactAttentionRollup[] {
  return ROLLUP_STATES.flatMap((state) => {
    const count = attentions.filter((attention) => attention === state).length
    if (count === 0) return []
    return [
      {
        state,
        letter: ROLLUP_LETTERS[state],
        count,
        label: rollupLabel(state, count),
        summary: rollupSummary(state, count),
      },
    ]
  })
}

export function compactAttentionSummary(
  rollups: readonly CompactAttentionRollup[],
): string {
  if (rollups.length === 0) return 'No terminals need attention'
  return rollups.map((rollup) => rollup.summary).join(', ')
}

function rollupLabel(state: CompactRollupState, count: number): string {
  const one = count === 1
  switch (state) {
    case 'prompt':
      return `${count} terminal ${one ? 'prompt' : 'prompts'}`
    case 'idle':
      return `${count} ${one ? 'terminal' : 'terminals'} ready`
    case 'bell':
      return `${count} terminal ${one ? 'bell' : 'bells'}`
  }
}

function rollupSummary(state: CompactRollupState, count: number): string {
  const one = count === 1
  switch (state) {
    case 'prompt':
      return `${count} ${one ? 'prompt' : 'prompts'}`
    case 'idle':
      return `${count} ready`
    case 'bell':
      return `${count} ${one ? 'bell' : 'bells'}`
  }
}
