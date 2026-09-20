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

/**
 * Enter leads: it is the key the bar exists for, sent after almost every
 * message a phone types, so it takes the place a thumb reaches without
 * looking rather than the end of a row that scrolls.
 */
export const COMPANION_KEYS: readonly CompanionKey[] = [
  { label: 'Enter', data: '\r' },
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl-C', data: '\u0003' },
  { label: '↑', data: '\u001b[A' },
  { label: '↓', data: '\u001b[B' },
  { label: '←', data: '\u001b[D' },
  { label: '→', data: '\u001b[C' },
]
