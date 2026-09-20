/**
 * The phone page's terminal port (ADR-050): the members of the desktop's
 * engine-neutral `TerminalPane` seam a mirror needs, with the same names, so
 * the page owns its emulator through the same shape without importing the
 * desktop renderer. A conformance test outside the page tree pins the match.
 *
 * A mirror pane follows the geometry main publishes and never resizes itself.
 * It draws a fixed readable font and reports one cell's size, so the page can
 * derive the grid its area holds and hold the PTY there for as long as it is
 * watching (ADR-058); the emulator itself changes size only through `resize`.
 * Input is off until the page enables it, and the bytes it emits are the
 * user's exact key bytes, uncomposed.
 *
 * Reading back is the emulator's own viewport and the page keeps no text of
 * its own (ADR-053), so the members this record adds past the ones the
 * desktop's own seam has are a gesture the emulator decides, the screen it is
 * on, where that viewport moves to, and the way back to the live edge. Moving
 * the viewport never touches the desktop, and every question here is about
 * position and mode: the page asks which screen is current and how far back the
 * view is without ever asking what either screen says. Position is reported and
 * never sampled, so the seam carries the subscription and no reader beside it.
 */
import type { TerminalWheelEvent } from '../../../shared'

export interface CompanionTerminalPaneEvents {
  /** The user's exact key bytes; nothing the emulator answers on its own. */
  onData(cb: (data: string, source: 'user') => void): () => void
  /**
   * The page keys a read-back gesture sends a program that owns its history
   * (ADR-055). Its own event rather than a source on `onData`: these bytes pass
   * different gates on the page and on the desktop alike, and `onData` is the
   * member narrowed against the desktop's own seam, where no such channel
   * exists. The pane emits a gesture's bytes on exactly one of the two.
   */
  onNavigation(cb: (data: string) => void): () => void
  /**
   * Every move of the viewport, whatever moved it: a gesture, the page's own
   * way back, a reflow re-anchoring it, output pushing a held position along.
   * The offset is read from the emulator rather than taken from the event,
   * which carries a whole number even where the viewport rests on a fraction.
   */
  onViewport(cb: (offset: number) => void): () => void
}

/** One cell's box in CSS pixels at the pane's font; what the page divides its area by. */
export interface CompanionCellSize {
  readonly width: number
  readonly height: number
}

export interface CompanionTerminalPane {
  mount(container: HTMLElement): void
  write(data: string): void
  /**
   * Follows the geometry main publishes; the pane never picks a size of its
   * own. A reflow leaves the viewport where it was, so a pane holding a
   * position behind a shortened scrollback re-anchors itself here.
   */
  resize(cols: number, rows: number): void
  /**
   * One gesture over the grid, a wheel notch or a finger drag, decided by the
   * one shared policy. The answer is the distance the pane's own viewport did
   * not take, in the pane's pixels and signed like the gesture, which the page
   * moves its own scroller by. Zero means the viewport absorbed all of it.
   */
  scroll(event: TerminalWheelEvent): number
  /**
   * The alternate screen keeps no scrollback of its own, so the viewport has
   * nothing to move over and a gesture pages the program instead (ADR-055).
   */
  isAlternateScreen(): boolean
  /**
   * The finger lifted or the gesture was cancelled. Whatever fraction of a
   * step the gesture had banked, toward a row of the viewport or a report to a
   * program, belongs to it and not to the next touch, which starts from zero.
   */
  endGesture(): void
  /** Puts the viewport back on the newest output, which is the page's one tap. */
  returnToLive(): void
  /** The cell's measured size once mounted; nothing before the emulator has drawn. */
  cellSize(): CompanionCellSize | undefined
  /** Ends the pane and releases every subscription it handed out, so no caller need. */
  dispose(): void
  setInputEnabled(enabled: boolean): void
  readonly events: CompanionTerminalPaneEvents
}

export type CompanionTerminalPaneFactory = (
  cols: number,
  rows: number,
) => Promise<CompanionTerminalPane>
