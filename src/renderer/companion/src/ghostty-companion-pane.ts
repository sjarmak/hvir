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
 */
import { Terminal, init } from 'ghostty-web'
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

import type {
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from './companion-terminal-pane'

const MIRROR_SCROLLBACK_BYTES = 1_000_000

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
    this.disposers.push(
      this.terminal.onData((data) => {
        if (this.writing > 0 || !this.inputEnabled) return
        for (const listener of this.listeners) listener(data, 'user')
      }),
    )
    this.terminal.open(container)
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
}
