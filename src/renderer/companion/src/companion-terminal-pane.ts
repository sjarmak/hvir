/**
 * The phone page's terminal port (ADR-050): the members of the desktop's
 * engine-neutral `TerminalPane` seam a mirror needs, with the same names, so
 * the page owns its emulator through the same shape without importing the
 * desktop renderer. A conformance test outside the page tree pins the match.
 *
 * A mirror pane follows the desktop's geometry and never reports a resize of
 * its own; input is off until the page enables it, and the bytes it emits are
 * the user's exact key bytes, uncomposed. Its view of the scrollback is the
 * one thing the page moves on its own, so reading earlier output never
 * touches the desktop.
 */
export interface CompanionTerminalPaneEvents {
  /** The user's exact key bytes; nothing the emulator answers on its own. */
  onData(cb: (data: string, source: 'user') => void): () => void
}

export interface CompanionTerminalPane {
  mount(container: HTMLElement): void
  write(data: string): void
  /** Follows the desktop's grid; the pane never asks for a size of its own. */
  resize(cols: number, rows: number): void
  /**
   * Moves the reader's view `amount` rows, positive toward live output: the
   * scrollback viewport on the normal screen, or the keys a full-screen
   * program reads for the same distance, sent as input under the same gate.
   */
  scrollLines(amount: number): void
  dispose(): void
  setInputEnabled(enabled: boolean): void
  readonly events: CompanionTerminalPaneEvents
}

export type CompanionTerminalPaneFactory = (
  cols: number,
  rows: number,
) => Promise<CompanionTerminalPane>
