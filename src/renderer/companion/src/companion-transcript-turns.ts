import type { SessionsTranscriptTurn } from '../../../shared'

export function newestTranscriptTurns(
  turns: readonly SessionsTranscriptTurn[],
): readonly SessionsTranscriptTurn[] {
  return [...turns].reverse()
}
