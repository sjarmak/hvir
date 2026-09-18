/**
 * The terminal keys a phone keyboard lacks, as on-screen controls (ADR-050).
 * Each sends exactly the bytes named here and nothing else: no newline is
 * appended, nothing is composed. Arrows use the CSI form; a program that has
 * switched the terminal to application cursor mode reads the same keys
 * differently, and the page does not track that mode.
 */
export interface CompanionKey {
  readonly label: string
  readonly data: string
}

export const COMPANION_KEYS: readonly CompanionKey[] = [
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl-C', data: '\u0003' },
  { label: '↑', data: '\u001b[A' },
  { label: '↓', data: '\u001b[B' },
  { label: '←', data: '\u001b[D' },
  { label: '→', data: '\u001b[C' },
  { label: 'Enter', data: '\r' },
]
