/**
 * One mirror's pane inside the terminal view: created at the geometry the
 * `opened` frame names, fed the tail and every later frame, replaced when a
 * new `opened` arrives, and scaled into the host. The pane is built
 * asynchronously (the emulator loads its module first), so frames that land
 * before it is ready are queued in order and written once it mounts.
 *
 * The grid is the desktop's: geometry frames resize the pane, and nothing
 * here ever reports a size back. Zoom is a CSS transform on the pane's
 * surface, so the emulator keeps its exact cell grid; the extent around the
 * surface takes the scaled size, so the host scrolls over exactly the grid.
 * A touch drag over the host scrolls the pane by rows; wheel input reaches
 * the pane directly.
 */
import type { CompanionTerminalEvent } from '../../../shared'
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
    host.append(this.extent)
    this.observer = new ResizeObserver(() => this.fit())
    this.observer.observe(host)
    this.gestures = new MirrorScrollGestures(host, {
      rowHeight: () => this.rowHeight(),
      scrollLines: (lines) => this.pane?.scrollLines(lines),
    })
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
        this.rows = event.rows
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

  setZoom(zoom: CompanionMirrorZoom): void {
    this.zoom = zoom
    this.fit()
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    this.gestures.dispose()
    this.pane?.dispose()
    this.pane = undefined
    this.pending = undefined
    this.extent.remove()
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
    this.fit()
  }

  private fail(pending: PendingPane, error: unknown): void {
    if (this.disposed || this.pending !== pending) return
    this.pending = undefined
    this.onFailure(error)
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

  /** Applies the zoom's scale to the surface and sizes the extent to match. */
  private fit(): void {
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
