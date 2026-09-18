/**
 * One mirror's pane inside the terminal view: created at the geometry the
 * `opened` frame names, fed the tail and every later frame, replaced when a
 * new `opened` arrives, and scaled to the host's width. The pane is built
 * asynchronously (the emulator loads its module first), so frames that land
 * before it is ready are queued in order and written once it mounts.
 *
 * The grid is the desktop's: geometry frames resize the pane, and nothing
 * here ever reports a size back. Fit to width is a CSS transform on the
 * pane's surface, so the emulator keeps its exact cell grid.
 */
import type { CompanionTerminalEvent } from '../../../shared'
import type {
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from './companion-terminal-pane'

interface PendingPane {
  readonly created: Promise<CompanionTerminalPane>
  readonly frames: string[]
  geometry?: { readonly cols: number; readonly rows: number }
}

export class CompanionTerminalMount {
  private pane?: CompanionTerminalPane
  private pending?: PendingPane
  private inputEnabled = false
  private disposed = false
  private readonly surface: HTMLDivElement
  private readonly observer: ResizeObserver

  constructor(
    private readonly host: HTMLElement,
    private readonly createPane: CompanionTerminalPaneFactory,
    private readonly onInput: (data: string) => void,
    private readonly onFailure: (error: unknown) => void,
  ) {
    this.surface = document.createElement('div')
    this.surface.className = 'companion-terminal-scale'
    host.append(this.surface)
    this.observer = new ResizeObserver(() => this.fit())
    this.observer.observe(host)
  }

  handle(event: CompanionTerminalEvent): void {
    switch (event.type) {
      case 'opened':
        this.open(event.cols, event.rows, event.tail)
        return
      case 'output':
        if (this.pane !== undefined) this.pane.write(event.data)
        else this.pending?.frames.push(event.data)
        return
      case 'geometry':
        if (this.pane !== undefined) {
          this.pane.resize(event.cols, event.rows)
          this.fit()
        } else if (this.pending !== undefined) {
          this.pending.geometry = { cols: event.cols, rows: event.rows }
        }
        return
      case 'ended':
        return
    }
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled
    this.pane?.setInputEnabled(enabled)
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    this.pane?.dispose()
    this.pane = undefined
    this.pending = undefined
    this.surface.remove()
  }

  private open(cols: number, rows: number, tail: string): void {
    this.pane?.dispose()
    this.pane = undefined
    this.surface.replaceChildren()
    const pending: PendingPane = { created: this.createPane(cols, rows), frames: [tail] }
    this.pending = pending
    void pending.created.then(
      (pane) => this.mountReady(pending, pane),
      (error: unknown) => this.fail(pending, error),
    )
  }

  /**
   * The queued frames are PTY bytes the emulator has never seen; a throw
   * while mounting or writing them is a failure of this pane, reported like a
   * pane that never loaded rather than left as an unhandled rejection.
   */
  private mountReady(pending: PendingPane, pane: CompanionTerminalPane): void {
    if (this.disposed || this.pending !== pending) {
      pane.dispose()
      return
    }
    try {
      pane.mount(this.surface)
      pane.events.onData((data) => this.onInput(data))
      pane.setInputEnabled(this.inputEnabled)
      for (const frame of pending.frames) pane.write(frame)
      if (pending.geometry !== undefined) {
        pane.resize(pending.geometry.cols, pending.geometry.rows)
      }
    } catch (error: unknown) {
      pane.dispose()
      this.surface.replaceChildren()
      this.fail(pending, error)
      return
    }
    this.pending = undefined
    this.pane = pane
    this.fit()
  }

  private fail(pending: PendingPane, error: unknown): void {
    if (this.disposed || this.pending !== pending) return
    this.pending = undefined
    this.onFailure(error)
  }

  /** Scales the surface down to the host width; a grid narrower than the host stays 1:1. */
  private fit(): void {
    const grid = this.surface.firstElementChild
    if (!(grid instanceof HTMLElement)) return
    const hostWidth = this.host.clientWidth
    const gridWidth = grid.offsetWidth
    if (hostWidth <= 0 || gridWidth <= 0) return
    const scale = Math.min(1, hostWidth / gridWidth)
    this.surface.style.transform = `scale(${scale})`
    this.host.style.height = `${Math.ceil(grid.offsetHeight * scale)}px`
  }
}
