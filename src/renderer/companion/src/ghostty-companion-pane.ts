/**
 * ghostty-web behind the Companion's terminal port (ADR-050). This is the one
 * file in the page tree that knows the emulator: it loads the WebAssembly
 * module from the Companion's own asset bundle once per document, builds a
 * terminal at the desktop's geometry with no fit controller, and never
 * subscribes to the emulator's own resize.
 *
 * The emulator answers some sequences on its own (device attributes, cursor
 * position) synchronously inside `write`; those replies are the desktop
 * renderer's to send, so they are dropped here rather than sent twice.
 *
 * One gesture over the grid follows the desktop pane's wheel policy, a wheel
 * notch and a finger drag alike (ADR-053): a full-screen program receives page
 * keys, a program tracking the mouse receives SGR reports, and anything the
 * policy leaves alone moves the emulator's own viewport, which is the mirror's
 * whole read-back. The viewport keeps its place while output arrives. The page
 * keys are read-back navigation and leave a disarmed mirror on their own event
 * (ADR-055), and a gesture event's reports leave it as one string in the order
 * the policy produced them, so a finger's travel reaches the program as one
 * ordered write rather than a race of requests; every other byte a gesture
 * produces is user input and passes the same gate as a key, so a disarmed
 * mirror sends nothing and a gesture the policy claimed whose bytes the gate
 * dropped is still the viewport's rather than lost. A drag shorter than one cell is kept as a remainder rather than
 * dropped, so reading back slowly still tracks the finger; at an edge the
 * viewport cannot pass, nothing is kept and the whole distance goes back to the
 * page so its own scroller tracks it instead.
 *
 * A resize reflows the scrollback without moving the viewport, so a viewport
 * held further back than the reflowed scrollback reaches is re-anchored to its
 * oldest row rather than left reporting a position the emulator no longer has.
 *
 * Where that viewport moves to is the one thing this file reports about the
 * screen, and it reports it from the emulator's own position and its own scroll
 * event: the page uses it to offer a way back to the live edge and asks nothing
 * about what any row says. Output arriving while the viewport is held behind
 * the live edge advances the position by the rows the scrollback grew, which is
 * how the emulator keeps the person on the rows they were reading, so the
 * position changes while the reading does not.
 */
import { Terminal, init } from 'ghostty-web'
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

import {
  TerminalWheelController,
  isTerminalReadBackNavigation,
  terminalWheelNotch,
  type TerminalWheelEvent,
} from '../../../shared'
import { COMPANION_DEFAULT_TEXT_SIZE, nearestTextSize } from './companion-text-size'
import type {
  CompanionCellSize,
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from './companion-terminal-pane'

/** The desktop pane's `TERMINAL_SCROLLBACK_BYTES`, so the phone reads back as far as the desktop. */
const MIRROR_SCROLLBACK_BYTES = 10_000_000
const FALLBACK_CELL_HEIGHT = 16

let initializeGhostty: Promise<void> | undefined

export const createGhosttyCompanionPane: CompanionTerminalPaneFactory = async (
  cols,
  rows,
) => {
  initializeGhostty ??= init({ wasmUrl: ghosttyWasmUrl })
  await initializeGhostty
  return new GhosttyCompanionPane(
    new Terminal({
      cols,
      rows,
      fontSize: COMPANION_DEFAULT_TEXT_SIZE,
      scrollbackBytes: MIRROR_SCROLLBACK_BYTES,
      disableStdin: true,
      disableContextMenu: true,
      focusOnOpen: false,
    }),
  )
}

class GhosttyCompanionPane implements CompanionTerminalPane {
  private readonly listeners = new Set<(data: string, source: 'user') => void>()
  private readonly navigationListeners = new Set<(data: string) => void>()
  private readonly viewportListeners = new Set<(offset: number) => void>()
  private readonly disposers: Array<{ dispose(): void }> = []
  private readonly wheel = new TerminalWheelController()
  private writing = 0
  /** Distance a drag covered that is short of a whole cell, kept for the next move. */
  private remainder = 0
  private inputEnabled = false
  private disposed = false

  constructor(private readonly terminal: Terminal) {}

  readonly events = {
    onData: (listener: (data: string, source: 'user') => void) => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    },
    onNavigation: (listener: (data: string) => void) => {
      this.navigationListeners.add(listener)
      return () => {
        this.navigationListeners.delete(listener)
      }
    },
    onViewport: (listener: (offset: number) => void) => {
      this.viewportListeners.add(listener)
      return () => {
        this.viewportListeners.delete(listener)
      }
    },
  }

  mount(container: HTMLElement): void {
    if (this.disposed) throw new Error('Cannot mount a disposed Companion pane')
    this.disposers.push(
      this.terminal.onData((data) => {
        this.emitUser(data)
      }),
      // The emulator's own event, not the number it carries: a smooth scroll
      // fires a floored value while the viewport rests on a fraction of a row,
      // which would read as the live edge four tenths of a row short of it.
      this.terminal.onScroll(() => {
        for (const listener of this.viewportListeners) {
          listener(this.terminal.getViewportY())
        }
      }),
    )
    this.terminal.open(container)
    this.terminal.attachCustomWheelEventHandler(
      (event) => this.navigate(terminalWheelNotch(event)).handled,
    )
  }

  write(data: string): void {
    this.writing += 1
    try {
      this.terminal.write(data)
    } finally {
      this.writing -= 1
    }
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
    this.anchorViewport()
  }

  /**
   * One gesture the shared policy decides, then the viewport for whatever the
   * policy left alone. The answer is the distance the emulator did not take,
   * in its own pixels and signed like the gesture. Bytes that reached a
   * program answer the gesture in that program's terms and move no pixel of
   * this surface, so the whole distance goes back for the page to scroll a
   * grid too tall for its host with.
   */
  scroll(event: TerminalWheelEvent): number {
    if (this.navigate(event).emitted) return event.deltaY
    return this.moveViewport(event)
  }

  /** The emulator's own mode flag; nothing here reads what the screen says. */
  isAlternateScreen(): boolean {
    return this.terminal.wasmTerm?.isAlternateScreen() ?? false
  }

  /**
   * ghostty's own way home, which cancels a smooth scroll in flight and fires
   * the scroll event once, so the page hears about it through the same path as
   * every other move rather than being told twice. The jump ends whatever drag
   * was in progress, so the sub-cell carry goes with it: a fraction of a row
   * kept from before the tap would otherwise let the next brush of the grid
   * move a whole row and put the way back on screen again unasked.
   */
  returnToLive(): void {
    this.endGesture()
    this.terminal.scrollToBottom()
  }

  /** The lift of the finger: the policy's bank and the viewport's fraction go with it. */
  endGesture(): void {
    this.wheel.endGesture()
    this.remainder = 0
  }

  /**
   * The person's size (ADR-059), read live by the emulator, which remeasures
   * its cell and redraws the grid it already has at the new box. The page asks
   * for the grid that new box earns; nothing here picks one.
   */
  setFontSize(size: number): void {
    this.terminal.options.fontSize = nearestTextSize(size)
  }

  /** The renderer exists once the terminal is open; its cell is the font's measured box. */
  cellSize(): CompanionCellSize | undefined {
    const renderer = this.terminal.renderer
    if (renderer === undefined) return undefined
    const { charWidth: width, charHeight: height } = renderer
    return width > 0 && height > 0 ? { width, height } : undefined
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled
    // Read live by the emulator on every key, so toggling needs no reopen.
    this.terminal.options.disableStdin = !enabled
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const disposer of this.disposers.splice(0)) disposer.dispose()
    this.listeners.clear()
    this.navigationListeners.clear()
    this.viewportListeners.clear()
    this.terminal.dispose()
  }

  /**
   * The desktop's decision for one gesture, and the only place its bytes are
   * emitted, so a gesture is never sent twice however it arrived. `handled` is
   * the wheel path's answer: false leaves a notch to the emulator's own smooth
   * scroll. `emitted` is whether a byte actually cleared the arming gate, which
   * is the narrower question `scroll` asks, since a policy that claimed the
   * gesture and sent nothing has left the viewport the only thing that can move.
   */
  private navigate(event: TerminalWheelEvent): {
    readonly handled: boolean
    readonly emitted: boolean
  } {
    const term = this.terminal.wasmTerm
    const renderer = this.terminal.renderer
    const result = this.wheel.handle(event, {
      alternateScreen: term?.isAlternateScreen() ?? false,
      mouseTracking: term?.hasMouseTracking() ?? false,
      sgrMouse: term?.getMode(1006) ?? false,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cellWidth: renderer?.charWidth ?? 1,
      cellHeight: renderer?.charHeight ?? FALLBACK_CELL_HEIGHT,
    })
    const navigation = result.data.filter(isTerminalReadBackNavigation)
    let emitted = navigation.length > 0 && this.emitNavigation(navigation.join(''))
    for (const data of result.data) {
      if (!isTerminalReadBackNavigation(data)) emitted = this.emitUser(data) || emitted
    }
    return { handled: result.handled, emitted }
  }

  /**
   * Wheel-equivalent viewport movement. ghostty's own wheel path scrolls to
   * `viewportY - deltaY / cellHeight` and `scrollLines` clamps that same
   * difference, so the amount is the delta in cells with its sign kept: a
   * negative delta walks away from the live edge at 0 and into the scrollback.
   * The answer is the distance the viewport did not take. A viewport pinned at
   * the edge the gesture asks for keeps no remainder and hands every pixel
   * back, so the page's own scroller tracks the whole finger rather than the
   * fraction of it that happens to cross a cell.
   */
  private moveViewport(event: TerminalWheelEvent): number {
    if (!Number.isFinite(event.deltaY)) return 0
    const renderer = this.terminal.renderer
    if (this.disposed || renderer === undefined) return event.deltaY
    const cellHeight =
      renderer.charHeight > 0 ? renderer.charHeight : FALLBACK_CELL_HEIGHT
    const cells = event.deltaY / cellHeight
    if (this.pinned(cells)) {
      this.remainder = 0
      return event.deltaY
    }
    if (this.remainder !== 0 && Math.sign(this.remainder) !== Math.sign(cells)) {
      this.remainder = 0
    }
    const total = this.remainder + cells
    const lines = Math.trunc(total)
    if (lines !== 0) {
      const before = this.terminal.getViewportY()
      this.terminal.scrollLines(lines)
      const moved = before - this.terminal.getViewportY()
      if (moved !== lines) {
        this.remainder = 0
        return (total - moved) * cellHeight
      }
    }
    this.remainder = total - lines
    return 0
  }

  /** The viewport is pinned when the direction asked for is past the scrollback it has. */
  private pinned(cells: number): boolean {
    const viewportY = this.terminal.getViewportY()
    return cells < 0 ? viewportY >= this.terminal.getScrollbackLength() : viewportY <= 0
  }

  /** A reflow leaves the viewport where it was, which a shortened scrollback no longer reaches. */
  private anchorViewport(): void {
    const length = this.terminal.getScrollbackLength()
    if (this.terminal.getViewportY() > length) this.terminal.scrollToLine(length)
  }

  /**
   * Read-back navigation (ADR-055, widened by ADR-056): the page keys a program
   * that owns its history receives and the wheel reports a program tracking the
   * mouse receives both leave a disarmed mirror, because the arm exists to stop
   * an unattended phone typing and a finger on the grid is neither. The
   * desktop's own permission still decides, and refuses these the same way it
   * refuses a key. One event's reports go out as one string: the wire admits a
   * batch of the closed set, and one write keeps them in the order they were
   * made.
   */
  private emitNavigation(data: string): boolean {
    for (const listener of this.navigationListeners) listener(data)
    return true
  }

  /** The one gate for user bytes: nothing while writing, nothing while disarmed. */
  private emitUser(data: string): boolean {
    if (this.writing > 0 || !this.inputEnabled) return false
    for (const listener of this.listeners) listener(data, 'user')
    return true
  }
}
