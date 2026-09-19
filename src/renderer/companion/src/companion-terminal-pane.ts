/**
 * The phone page's terminal port (ADR-050): the members of the desktop's
 * engine-neutral `TerminalPane` seam a mirror needs, with the same names, so
 * the page owns its emulator through the same shape without importing the
 * desktop renderer. A conformance test outside the page tree pins the match.
 *
 * A mirror pane follows the geometry main publishes and never resizes itself.
 * It draws a fixed readable font and reports one cell's size, so the page can
 * derive the grid its area holds and ask the desktop for it while Away
 * (ADR-052); the emulator itself changes size only through `resize`. Input is
 * off until the page enables it, and the bytes it emits are the user's exact
 * key bytes, uncomposed. Its view of the scrollback is the one thing the page
 * moves on its own, so reading earlier output never touches the desktop.
 */
export interface CompanionTerminalPaneEvents {
  /** The user's exact key bytes; nothing the emulator answers on its own. */
  onData(cb: (data: string, source: 'user') => void): () => void
}

/** One row of the emulator's active screen or scrollback, as text. */
export interface CompanionBufferLine {
  readonly text: string
  /** The emulator broke the line before this one at the desktop's width; this row continues it. */
  readonly wrapped: boolean
}

/** The font the emulator draws cells with, so text laid out beside the grid lines up with it. */
export interface CompanionCellFont {
  readonly family: string
  readonly size: number
}

/** One cell's box in CSS pixels at the pane's font; what the page divides its area by. */
export interface CompanionCellSize {
  readonly width: number
  readonly height: number
}

export interface CompanionTerminalPane {
  mount(container: HTMLElement): void
  write(data: string): void
  /** Follows the geometry main publishes; the pane never picks a size of its own. */
  resize(cols: number, rows: number): void
  /**
   * The newest `limit` rows of the active screen with its scrollback, oldest
   * first, for the page to lay out at its own width. Reading never moves the
   * emulator's view and never touches the desktop.
   */
  bufferLines(limit: number): readonly CompanionBufferLine[]
  /** The cell font, fixed for the pane's life. */
  font(): CompanionCellFont
  /** The cell's measured size once mounted; nothing before the emulator has drawn. */
  cellSize(): CompanionCellSize | undefined
  dispose(): void
  setInputEnabled(enabled: boolean): void
  readonly events: CompanionTerminalPaneEvents
}

export type CompanionTerminalPaneFactory = (
  cols: number,
  rows: number,
) => Promise<CompanionTerminalPane>
