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
 * The extent around the surface takes the scaled size of the grid, so the host
 * scrolls over exactly the screen the emulator draws.
 *
 * Read-back is the emulator's viewport and the page holds no text of its own
 * (ADR-053). There is one read-back gesture: a wheel notch reaches the pane
 * directly, and a finger over the grid is adapted into the same event shape,
 * divided by this mount's current scale so the content tracks the finger
 * rather than the emulator's unscaled pixels. Two scrollers sit end to end
 * under that one gesture, and the lift of the finger ends it for the pane so no
 * fraction of it is carried into the next: the emulator's viewport holds everything above the
 * grid, and this host's own scroll holds the part of a grid too tall for the
 * phone. Whichever lies in the direction the finger travels takes the distance
 * first and hands on what it could not take, so a host scrolled down over a
 * tall grid comes back up the same way it went down, and a program answering
 * the gesture with keys of its own still leaves the rows below the fold
 * reachable. The way back is that same strip travelled at once rather than a
 * second route through it, so both scrollers land on the newest output
 * together. The mount also reports which screen the emulator is on, so the
 * view can say that a full-screen program keeps its own history and a drag
 * pages through it (ADR-055), and whether the viewport sits behind the newest
 * output, so the view can offer the one tap back to it. That second report is a
 * subscription and never a sample:
 * a wheel notch the policy leaves alone is scrolled by the emulator itself and
 * reaches this mount through no call of its own, and the subscription is in
 * place before the first queued frame is written. It is a position and never a
 * line of text.
 */
import type { CompanionTerminalEvent, TerminalWheelEvent } from '../../../shared'
import {
  CompanionFitController,
  type CompanionResizeAnswer,
} from './companion-terminal-fit'
import type {
  CompanionTerminalPane,
  CompanionTerminalPaneFactory,
} from './companion-terminal-pane'
import { CompanionTouchScroll } from './companion-touch-scroll'

interface PendingPane {
  readonly created: Promise<CompanionTerminalPane>
  readonly frames: string[]
  geometry?: { readonly cols: number; readonly rows: number }
}

/**
 * Why the mirror is sending bytes: the person typing, or a read-back gesture
 * paging a program through its own history (ADR-055). They pass different gates
 * on the page and on the desktop, so the word travels with the bytes.
 */
export type CompanionInputSource = 'user' | 'navigation'

export interface CompanionTerminalMountOptions {
  readonly host: HTMLElement
  readonly createPane: CompanionTerminalPaneFactory
  /** The pane's bytes with what produced them, since the two are gated apart (ADR-055). */
  readonly onInput: (data: string, source: CompanionInputSource) => void
  /** The grid the host holds, asked for only while the mirror is live and the desktop is Away. */
  readonly onResize: (cols: number, rows: number) => Promise<CompanionResizeAnswer>
  /** The desktop's answer to the latest grid asked for. */
  readonly onResizeAnswered: (answer: CompanionResizeAnswer) => void
  /** Which screen the emulator is on; an alternate screen is paged rather than scrolled (ADR-055). */
  readonly onAlternateScreen: (alternate: boolean) => void
  /** Whether the viewport sits behind the newest output, which is when the way back is offered. */
  readonly onReadingBack: (readingBack: boolean) => void
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
  /** Undefined until the first report, so a fresh mount states its screen rather than assuming it. */
  private alternateScreen?: boolean
  /** Undefined until the first report, stated for the same reason as the screen. */
  private readingBack?: boolean
  private scale = 1
  /** The extent's scaled height, which is what the host has to scroll over. */
  private extentHeight = 0
  private disposed = false
  private readonly host: HTMLElement
  private readonly extent: HTMLDivElement
  private readonly surface: HTMLDivElement
  private readonly gridBox: HTMLDivElement
  private readonly touch: CompanionTouchScroll
  private readonly fitter: CompanionFitController
  private readonly observer: ResizeObserver

  constructor(private readonly options: CompanionTerminalMountOptions) {
    const { host } = options
    this.host = host
    this.extent = document.createElement('div')
    this.extent.className = 'companion-terminal-extent'
    this.surface = document.createElement('div')
    this.surface.className = 'companion-terminal-scale'
    this.gridBox = document.createElement('div')
    this.gridBox.className = 'companion-terminal-grid'
    this.surface.append(this.gridBox)
    this.extent.append(this.surface)
    host.append(this.extent)
    this.touch = new CompanionTouchScroll({
      element: this.gridBox,
      scale: () => this.scale,
      sink: (event) => this.scrolled(event),
      end: () => this.pane?.endGesture(),
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
          this.fit()
          this.reportScreen()
        } else {
          this.pending?.frames.push(event.data)
        }
        return
      case 'geometry':
        this.fitter.applied({ cols: event.cols, rows: event.rows })
        if (this.pane !== undefined) {
          this.pane.resize(event.cols, event.rows)
          this.fit()
          this.reportScreen()
        } else if (this.pending !== undefined) {
          this.pending.geometry = { cols: event.cols, rows: event.rows }
        }
        return
      case 'ended':
        this.fitter.setLive(false)
        this.setAlternateScreen(false)
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

  /**
   * The one tap back to the newest output, which is the far end of the strip
   * the gesture travels rather than the viewport alone: the emulator returns
   * to its live edge and this host runs to the bottom of the grid, so a grid
   * taller than the phone lands on its newest rows and not on its first. An
   * ended session still has a viewport and still has a newest output, so this
   * stays answerable for as long as the pane does.
   */
  returnToLive(): void {
    if (this.pane === undefined) return
    this.pane.returnToLive()
    this.host.scrollTop = this.hostLimit()
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    this.touch.dispose()
    this.fitter.dispose()
    this.releaseMirror()
    this.pending = undefined
    this.extent.remove()
  }

  private open(cols: number, rows: number, preamble: string, tail: string): void {
    this.fitter.setLive(false)
    this.releaseMirror()
    this.gridBox.replaceChildren()
    this.setAlternateScreen(false)
    this.setReadingBack(false)
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
      pane.events.onData((data) => this.options.onInput(data, 'user'))
      pane.events.onNavigation((data) => this.options.onInput(data, 'navigation'))
      // Before the queued frames, so a write that moves the viewport is heard
      // rather than missed and then sampled for.
      pane.events.onViewport((offset) => this.setReadingBack(offset !== 0))
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
    this.fit()
    this.reportScreen()
    this.fitter.setLive(true)
  }

  private fail(pending: PendingPane, error: unknown): void {
    if (this.disposed || this.pending !== pending) return
    this.pending = undefined
    this.options.onFailure(error)
  }

  /**
   * One read-back gesture across two scrollers end to end. Toward older
   * content the host is the nearer one, so it gives back its own travel before
   * the emulator's scrollback is asked for any; toward the live edge the
   * viewport goes first and the host takes whatever is left. Either way the
   * finger moves the same number of on-screen pixels of content.
   */
  private scrolled(event: TerminalWheelEvent): void {
    const pane = this.pane
    if (pane === undefined) return
    if (event.deltaY < 0) {
      const left = this.hostScroll(event.deltaY)
      if (left !== 0) pane.scroll({ ...event, deltaY: left })
      return
    }
    this.hostScroll(pane.scroll(event))
  }

  /**
   * The host's own scroller, spoken to in the pane's pixels: it takes what its
   * own range allows and answers the rest. The range is the extent this mount
   * sized against the host it was given, so it needs no layout of its own.
   */
  private hostScroll(delta: number): number {
    if (delta === 0) return 0
    const before = this.host.scrollTop
    const next = Math.min(this.hostLimit(), Math.max(0, before + delta * this.scale))
    this.host.scrollTop = next
    return delta - (next - before) / this.scale
  }

  /** How far this host can travel over the extent the fit sized for it. */
  private hostLimit(): number {
    return Math.max(0, this.extentHeight - this.host.clientHeight)
  }

  /** The emulator's mode, reported on change; the page never reads the screen itself. */
  private reportScreen(): void {
    if (this.pane === undefined) return
    this.setAlternateScreen(this.pane.isAlternateScreen())
  }

  private setAlternateScreen(alternate: boolean): void {
    if (this.alternateScreen === alternate) return
    this.alternateScreen = alternate
    this.options.onAlternateScreen(alternate)
  }

  /**
   * Zero is the live edge exactly: every mover the emulator has clamps there,
   * so a viewport resting a fraction of a row behind it is behind it.
   */
  private setReadingBack(readingBack: boolean): void {
    if (this.readingBack === readingBack) return
    this.readingBack = readingBack
    this.options.onReadingBack(readingBack)
  }

  /** Lets go of the mirror; disposing a pane releases every subscription it handed out. */
  private releaseMirror(): void {
    this.pane?.dispose()
    this.pane = undefined
  }

  private grid(): HTMLElement | undefined {
    const grid = this.gridBox.firstElementChild
    return grid instanceof HTMLElement ? grid : undefined
  }

  /**
   * Scales the surface to the host's width and sizes the extent to the scaled
   * grid, which is the whole of what the surface holds.
   */
  private fit(): void {
    const grid = this.grid()
    if (grid === undefined) return
    const scale = fitWidthScale(this.host.clientWidth, grid.offsetWidth)
    if (scale === undefined) return
    this.scale = scale
    this.surface.style.transform = `scale(${scale})`
    this.extentHeight = Math.ceil(grid.offsetHeight * scale)
    this.extent.style.width = `${Math.ceil(grid.offsetWidth * scale)}px`
    this.extent.style.height = `${this.extentHeight}px`
  }
}
