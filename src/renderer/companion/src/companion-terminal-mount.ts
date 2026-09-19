/**
 * One mirror's pane inside the terminal view: created at the geometry the
 * `opened` frame names, fed the sticky-mode preamble, then the tail and every
 * later frame, replaced when a new `opened` arrives, and shown in the host
 * scaled to its width. The preamble puts the fresh emulator on the screen the
 * session is already on before a byte of the tail lands, and is skipped when the
 * frame carries none (ADR-054). The pane is built asynchronously (the emulator
 * loads its module first), so frames that land before it is ready are queued in
 * order and written once it mounts.
 *
 * The grid is whatever main publishes: geometry frames resize the pane, and
 * the emulator never picks a size of its own. While the desktop is Away the
 * mount asks for the grid the host's area holds at the pane's cell size
 * (ADR-052). The view is a CSS transform on the pane's surface that sets the
 * grid's columns to the host's width and never enlarges, so the emulator
 * keeps its exact cell grid: the desktop's wide grid shrinks to fit, and the
 * phone's own grid, already the host's width, draws at scale 1 (or a hair
 * under when a cell advance rounds past the host, so no column is clipped).
 * The scrollback is drawn above the grid in the same surface, at the grid's
 * cell metrics, and the extent around the surface takes the scaled size of
 * the two, so the host scrolls over exactly one column of history then live
 * screen. Wheel input over the grid reaches the pane directly.
 */
import type { CompanionTerminalEvent } from '../../../shared'
import { HISTORY_LINE_LIMIT, MirrorHistory } from './companion-mirror-history'
import {
  CompanionFitController,
  type CompanionResizeAnswer,
} from './companion-terminal-fit'
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

export interface CompanionTerminalMountOptions {
  readonly host: HTMLElement
  readonly createPane: CompanionTerminalPaneFactory
  readonly onInput: (data: string) => void
  /** The grid the host holds, asked for only while the mirror is live and the desktop is Away. */
  readonly onResize: (cols: number, rows: number) => Promise<CompanionResizeAnswer>
  /** The desktop's answer to the latest grid asked for. */
  readonly onResizeAnswered: (answer: CompanionResizeAnswer) => void
  readonly onFailure: (error: unknown) => void
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
  private readonly host: HTMLElement
  private readonly extent: HTMLDivElement
  private readonly surface: HTMLDivElement
  private readonly historyBox: HTMLPreElement
  private readonly gridBox: HTMLDivElement
  private readonly history: MirrorHistory
  private readonly fitter: CompanionFitController
  private readonly observer: ResizeObserver

  constructor(private readonly options: CompanionTerminalMountOptions) {
    const { host } = options
    this.host = host
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
    this.fitter = new CompanionFitController({
      area: () => ({ width: host.clientWidth, height: host.clientHeight }),
      cell: () => this.pane?.cellSize(),
      request: ({ cols, rows }) => options.onResize(cols, rows),
      answered: (answer) => options.onResizeAnswered(answer),
    })
    this.observer = new ResizeObserver(() => {
      this.fit()
      this.fitter.areaChanged()
    })
    this.observer.observe(host)
  }

  handle(event: CompanionTerminalEvent): void {
    switch (event.type) {
      case 'opened':
        this.open(event.cols, event.rows, event.preamble ?? '', event.tail)
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
        this.fitter.applied({ cols: event.cols, rows: event.rows })
        this.rows = event.rows
        if (this.pane !== undefined) {
          this.pane.resize(event.cols, event.rows)
          this.history.refresh()
        } else if (this.pending !== undefined) {
          this.pending.geometry = { cols: event.cols, rows: event.rows }
        }
        return
      case 'ended':
        this.fitter.setLive(false)
        return
    }
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled
    this.pane?.setInputEnabled(enabled)
  }

  /** What the snapshot says about the desktop's focus (ADR-049); the fit asks only while Away. */
  setAway(away: boolean): void {
    this.fitter.setAway(away)
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    this.fitter.dispose()
    this.history.dispose()
    this.pane?.dispose()
    this.pane = undefined
    this.pending = undefined
    this.extent.remove()
  }

  private open(cols: number, rows: number, preamble: string, tail: string): void {
    this.fitter.setLive(false)
    this.pane?.dispose()
    this.pane = undefined
    this.rows = rows
    this.gridBox.replaceChildren()
    const pending: PendingPane = {
      created: this.options.createPane(cols, rows),
      frames: preamble.length > 0 ? [preamble, tail] : [tail],
    }
    this.pending = pending
    void pending.created.then(
      (pane) => this.mountReady(pending, pane),
      (error: unknown) => this.fail(pending, error),
    )
  }

  /**
   * The queued frames are PTY bytes the emulator has never seen; a throw
   * while mounting or writing them is a failure of this pane, reported like a
   * pane that never loaded rather than left as an unhandled rejection. The
   * fit goes live only here, once there is a mounted pane to measure.
   */
  private mountReady(pending: PendingPane, pane: CompanionTerminalPane): void {
    if (this.disposed || this.pending !== pending) {
      pane.dispose()
      return
    }
    try {
      pane.mount(this.gridBox)
      pane.events.onData((data) => this.options.onInput(data))
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
    this.fitter.setLive(true)
  }

  private fail(pending: PendingPane, error: unknown): void {
    if (this.disposed || this.pending !== pending) return
    this.pending = undefined
    this.options.onFailure(error)
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
