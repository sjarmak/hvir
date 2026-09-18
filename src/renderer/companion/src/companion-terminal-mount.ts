/**
 * One mirror's pane inside the terminal view: created at the geometry the
 * `opened` frame names, fed the tail and every later frame, replaced when a
 * new `opened` arrives, and shown in the host by the view in force. The pane
 * is built asynchronously (the emulator loads its module first), so frames
 * that land before it is ready are queued in order and written once it
 * mounts.
 *
 * The grid is the desktop's: geometry frames resize the pane, and nothing
 * here ever reports a size back. The reflow view hides the grid and shows the
 * emulator's text at the phone's width in a page of its own, which the
 * browser scrolls. A grid view is a CSS transform on the pane's surface, so
 * the emulator keeps its exact cell grid; the extent around the surface takes
 * the scaled size, so the host scrolls over exactly the grid, and a touch drag
 * over the host scrolls the pane by rows. Wheel input reaches the pane
 * directly in every view.
 */
import type { CompanionTerminalEvent } from '../../../shared'
import { MirrorReflow, REFLOW_LINE_LIMIT } from './companion-mirror-reflow'
import { MirrorScrollGestures } from './companion-mirror-scroll'
import {
  DEFAULT_MIRROR_ZOOM,
  mirrorScale,
  type CompanionMirrorZoom,
} from './companion-mirror-zoom'
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
  private zoom: CompanionMirrorZoom = DEFAULT_MIRROR_ZOOM
  private rows = 0
  private scale = 1
  private disposed = false
  private readonly extent: HTMLDivElement
  private readonly surface: HTMLDivElement
  private readonly page: HTMLPreElement
  private readonly reflow: MirrorReflow
  private readonly observer: ResizeObserver
  private readonly gestures: MirrorScrollGestures

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
    this.extent.append(this.surface)
    this.page = document.createElement('pre')
    this.page.className = 'companion-terminal-reflow'
    host.append(this.extent, this.page)
    this.reflow = new MirrorReflow(
      this.page,
      () => this.pane?.bufferLines(REFLOW_LINE_LIMIT) ?? [],
    )
    this.observer = new ResizeObserver(() => this.fit())
    this.observer.observe(host)
    this.gestures = new MirrorScrollGestures(host, {
      rowHeight: () => this.rowHeight(),
      scrollLines: (lines) => this.pane?.scrollLines(lines),
    })
    this.show()
  }

  handle(event: CompanionTerminalEvent): void {
    switch (event.type) {
      case 'opened':
        this.open(event.cols, event.rows, event.tail)
        return
      case 'output':
        if (this.pane !== undefined) this.write(event.data)
        else this.pending?.frames.push(event.data)
        return
      case 'geometry':
        this.rows = event.rows
        if (this.pane !== undefined) {
          this.pane.resize(event.cols, event.rows)
          this.fit()
          this.refreshPage()
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

  setZoom(zoom: CompanionMirrorZoom): void {
    this.zoom = zoom
    this.show()
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    this.gestures.dispose()
    this.reflow.dispose()
    this.pane?.dispose()
    this.pane = undefined
    this.pending = undefined
    this.extent.remove()
    this.page.remove()
  }

  private open(cols: number, rows: number, tail: string): void {
    this.pane?.dispose()
    this.pane = undefined
    this.rows = rows
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
    this.show()
  }

  private fail(pending: PendingPane, error: unknown): void {
    if (this.disposed || this.pending !== pending) return
    this.pending = undefined
    this.onFailure(error)
  }

  private write(data: string): void {
    this.pane?.write(data)
    if (this.zoom === 'reflow') this.reflow.schedule()
  }

  private refreshPage(): void {
    if (this.zoom === 'reflow') this.reflow.refresh()
  }

  /** The view in force: the page of text, or the grid scaled into the host. */
  private show(): void {
    const reflowing = this.zoom === 'reflow'
    this.extent.hidden = reflowing
    this.page.hidden = !reflowing
    this.gestures.setEnabled(!reflowing)
    if (reflowing) this.reflow.refresh()
    else this.fit()
  }

  private grid(): HTMLElement | undefined {
    const grid = this.surface.firstElementChild
    return grid instanceof HTMLElement ? grid : undefined
  }

  /** One row's height on screen: the grid's unscaled height per row, scaled. */
  private rowHeight(): number {
    const grid = this.grid()
    if (grid === undefined || this.rows <= 0) return 0
    return (grid.offsetHeight / this.rows) * this.scale
  }

  /** Applies a grid view's scale to the surface and sizes the extent to match. */
  private fit(): void {
    if (this.zoom === 'reflow') return
    const grid = this.grid()
    if (grid === undefined) return
    const scale = mirrorScale(this.zoom, {
      hostWidth: this.host.clientWidth,
      hostHeight: this.host.clientHeight,
      gridWidth: grid.offsetWidth,
      gridHeight: grid.offsetHeight,
    })
    if (scale === undefined) return
    this.scale = scale
    this.surface.style.transform = `scale(${scale})`
    this.extent.style.width = `${Math.ceil(grid.offsetWidth * scale)}px`
    this.extent.style.height = `${Math.ceil(grid.offsetHeight * scale)}px`
  }
}
