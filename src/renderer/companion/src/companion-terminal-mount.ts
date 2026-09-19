/**
 * One mirror's pane inside the terminal view: created at the geometry the
 * `opened` frame names, fed the tail and every later frame, replaced when a
 * new `opened` arrives, and shown in the host scaled to its width. The pane
 * is built asynchronously (the emulator loads its module first), so frames
 * that land before it is ready are queued in order and written once it
 * mounts.
 *
 * The grid is the desktop's: geometry frames resize the pane, and nothing
 * here ever reports a size back. The view is a CSS transform on the pane's
 * surface that sets the desktop's columns to the host's width and never
 * enlarges, so the emulator keeps its exact cell grid. The scrollback is
 * drawn above the grid in the same surface, at the grid's cell metrics, and
 * the extent around the surface takes the scaled size of the two, so the
 * host scrolls over exactly one column of history then live screen. Wheel
 * input over the grid reaches the pane directly.
 */
import type { CompanionTerminalEvent } from '../../../shared'
import { HISTORY_LINE_LIMIT, MirrorHistory } from './companion-mirror-history'
import type {
  CompanionBufferLine,
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from './companion-terminal-pane'

interface PendingPane {
  readonly created: Promise<CompanionTerminalPane>
  readonly frames: string[]
  geometry?: { readonly cols: number; readonly rows: number }
}

/** The scale that sets the grid's width to the host's, never above 1; nothing while either has no layout. */
export function fitWidthScale(hostWidth: number, gridWidth: number): number | undefined {
  if (hostWidth <= 0 || gridWidth <= 0) return undefined
  return Math.min(1, hostWidth / gridWidth)
}

export class CompanionTerminalMount {
  private pane?: CompanionTerminalPane
  private pending?: PendingPane
  private inputEnabled = false
  private rows = 0
  private disposed = false
  private readonly extent: HTMLDivElement
  private readonly surface: HTMLDivElement
  private readonly historyBox: HTMLPreElement
  private readonly gridBox: HTMLDivElement
  private readonly history: MirrorHistory
  private readonly observer: ResizeObserver

  constructor(
    private readonly host: HTMLElement,
    private readonly createPane: CompanionTerminalPaneFactory,
    private readonly onInput: (data: string) => void,
    private readonly onFailure: (error: unknown) => void,
  ) {
    this.extent = document.createElement('div')
    this.extent.className = 'companion-terminal-extent'
    this.surface = document.createElement('div')
    this.surface.className = 'companion-terminal-scale'
    this.historyBox = document.createElement('pre')
    this.historyBox.className = 'companion-terminal-history'
    this.gridBox = document.createElement('div')
    this.gridBox.className = 'companion-terminal-grid'
    this.surface.append(this.historyBox, this.gridBox)
    this.extent.append(this.surface)
    host.append(this.extent)
    this.history = new MirrorHistory({
      scroller: host,
      text: this.historyBox,
      source: () => this.scrollback(),
      afterRefresh: () => this.fit(),
    })
    this.observer = new ResizeObserver(() => this.fit())
    this.observer.observe(host)
  }

  handle(event: CompanionTerminalEvent): void {
    switch (event.type) {
      case 'opened':
        this.open(event.cols, event.rows, event.tail)
        return
      case 'output':
        if (this.pane !== undefined) {
          this.pane.write(event.data)
          this.history.schedule()
        } else {
          this.pending?.frames.push(event.data)
        }
        return
      case 'geometry':
        this.rows = event.rows
        if (this.pane !== undefined) {
          this.pane.resize(event.cols, event.rows)
          this.history.refresh()
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
    this.history.dispose()
    this.pane?.dispose()
    this.pane = undefined
    this.pending = undefined
    this.extent.remove()
  }

  private open(cols: number, rows: number, tail: string): void {
    this.pane?.dispose()
    this.pane = undefined
    this.rows = rows
    this.gridBox.replaceChildren()
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
      pane.mount(this.gridBox)
      pane.events.onData((data) => this.onInput(data))
      pane.setInputEnabled(this.inputEnabled)
      for (const frame of pending.frames) pane.write(frame)
      if (pending.geometry !== undefined) {
        pane.resize(pending.geometry.cols, pending.geometry.rows)
      }
    } catch (error: unknown) {
      pane.dispose()
      this.gridBox.replaceChildren()
      this.fail(pending, error)
      return
    }
    this.pending = undefined
    this.pane = pane
    const font = pane.font()
    this.historyBox.style.fontFamily = font.family
    this.historyBox.style.fontSize = `${font.size}px`
    this.history.refresh()
  }

  private fail(pending: PendingPane, error: unknown): void {
    if (this.disposed || this.pending !== pending) return
    this.pending = undefined
    this.onFailure(error)
  }

  /** The scrollback: every row of the active buffer before the screen's own rows. */
  private scrollback(): readonly CompanionBufferLine[] {
    if (this.pane === undefined) return []
    const lines = this.pane.bufferLines(HISTORY_LINE_LIMIT + this.rows)
    return lines.slice(0, Math.max(0, lines.length - this.rows))
  }

  private grid(): HTMLElement | undefined {
    const grid = this.gridBox.firstElementChild
    return grid instanceof HTMLElement ? grid : undefined
  }

  /**
   * Scales the surface to the host's width and sizes the extent to what the
   * surface holds. The history's rows are the grid's columns in the grid's
   * font and take its row height, so the two read as one column of the
   * grid's width.
   */
  private fit(): void {
    const grid = this.grid()
    if (grid === undefined) return
    const scale = fitWidthScale(this.host.clientWidth, grid.offsetWidth)
    if (scale === undefined) return
    this.historyBox.style.lineHeight = `${grid.offsetHeight / this.rows}px`
    const height = grid.offsetHeight + this.historyBox.offsetHeight
    this.surface.style.transform = `scale(${scale})`
    this.extent.style.width = `${Math.ceil(grid.offsetWidth * scale)}px`
    this.extent.style.height = `${Math.ceil(height * scale)}px`
  }
}
