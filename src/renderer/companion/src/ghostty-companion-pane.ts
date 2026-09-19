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
 * Wheel input over the grid follows the desktop pane's wheel policy: the
 * emulator's viewport moves on the normal screen and keeps its place while
 * output arrives, a full-screen program receives page keys, and a program
 * tracking the mouse receives SGR reports. Those bytes are user input and
 * pass the same gate as any key, so a disarmed mirror sends nothing.
 */
import { Terminal, init } from 'ghostty-web'
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

import { TerminalWheelController, type TerminalWheelEvent } from '../../../shared'
import type {
  CompanionBufferLine,
  CompanionCellFont,
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from './companion-terminal-pane'

const MIRROR_SCROLLBACK_BYTES = 1_000_000
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
      scrollbackBytes: MIRROR_SCROLLBACK_BYTES,
      disableStdin: true,
      disableContextMenu: true,
      focusOnOpen: false,
    }),
  )
}

class GhosttyCompanionPane implements CompanionTerminalPane {
  private readonly listeners = new Set<(data: string, source: 'user') => void>()
  private readonly disposers: Array<{ dispose(): void }> = []
  private readonly wheel = new TerminalWheelController()
  private writing = 0
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
  }

  mount(container: HTMLElement): void {
    if (this.disposed) throw new Error('Cannot mount a disposed Companion pane')
    this.disposers.push(this.terminal.onData((data) => this.emitUser(data)))
    this.terminal.open(container)
    this.terminal.attachCustomWheelEventHandler((event) => this.navigate(event))
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
  }

  /** Rows from the active buffer's end; `translateToString` keeps the width, the page trims. */
  bufferLines(limit: number): readonly CompanionBufferLine[] {
    const buffer = this.terminal.buffer.active
    const lines: CompanionBufferLine[] = []
    for (let y = Math.max(0, buffer.length - limit); y < buffer.length; y += 1) {
      const line = buffer.getLine(y)
      if (line === undefined) continue
      lines.push({ text: line.translateToString(false), wrapped: line.isWrapped })
    }
    return lines
  }

  font(): CompanionCellFont {
    return {
      family: this.terminal.options.fontFamily,
      size: this.terminal.options.fontSize,
    }
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
    this.terminal.dispose()
  }

  /**
   * The desktop's wheel decision. Unhandled means the emulator's own viewport
   * takes the gesture; handled means the bytes, if any, were sent as input.
   */
  private navigate(event: TerminalWheelEvent): boolean {
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
    for (const data of result.data) this.emitUser(data)
    return result.handled
  }

  /** The one gate for user bytes: nothing while writing, nothing while disarmed. */
  private emitUser(data: string): void {
    if (this.writing > 0 || !this.inputEnabled) return
    for (const listener of this.listeners) listener(data, 'user')
  }
}
