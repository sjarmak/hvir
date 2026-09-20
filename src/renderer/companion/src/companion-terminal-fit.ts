/**
 * The phone's fit (ADR-058): how many whole cells of the pane's fixed font the terminal
 * area holds, and when to tell the desktop that grid. A watching page owns the size of
 * what it watches, so the only condition is a live mirror over a mounted pane: one grid
 * once the mirror opens, and one more after the area settles following a change
 * (orientation, the soft keyboard, a header line appearing). Nothing here asks what the
 * desktop is doing; focus never enters this decision.
 *
 * At most one request is in flight; a grid fitted meanwhile waits and goes out when the
 * first settles, so the PTY ends at the latest grid. A request that fails is forgotten
 * rather than retried on a timer: the same grid goes out again at the next settle, and the
 * page keeps drawing whatever size the PTY actually has meanwhile. The PTY's new size
 * arrives as a geometry frame like any other; `applied` keeps the request while that frame
 * matches it and forgets it when the PTY took some other size instead.
 *
 * Nothing here talks to the network or the DOM; the mount supplies the area, the cell, and
 * the verb.
 */
import {
  MAX_COMPANION_VIEWPORT_DIMENSION,
  MIN_COMPANION_VIEWPORT_DIMENSION,
} from '../../../shared'
import type { CompanionCellSize } from './companion-terminal-pane'

/** Layout settles for this long before one grid is asked for; the desktop's fit waits the same. */
export const FIT_SETTLE_MS = 75

export interface CompanionArea {
  readonly width: number
  readonly height: number
}

export interface CompanionGrid {
  readonly cols: number
  readonly rows: number
}

/** Whole cells the area holds, within the bounds the listener accepts; nothing without a layout. */
export function fitCompanionGrid(
  area: CompanionArea,
  cell: CompanionCellSize,
): CompanionGrid | undefined {
  const measures = [area.width, area.height, cell.width, cell.height]
  if (measures.some((measure) => !Number.isFinite(measure) || measure <= 0)) {
    return undefined
  }
  return {
    cols: boundDimension(Math.floor(area.width / cell.width)),
    rows: boundDimension(Math.floor(area.height / cell.height)),
  }
}

export interface CompanionFitSources {
  /** The terminal area's content box, in CSS pixels. */
  readonly area: () => CompanionArea
  /** The mounted pane's cell, or nothing while there is no pane to measure. */
  readonly cell: () => CompanionCellSize | undefined
  /** Tells the desktop this page is drawing this grid; rejects when the verb could not be made. */
  readonly request: (grid: CompanionGrid) => Promise<void>
}

export class CompanionFitController {
  private live = false
  /** The latest grid wanted: in flight, waiting behind it, or already taken. */
  private requested?: CompanionGrid
  private inFlight?: CompanionGrid
  private pending?: CompanionGrid
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly sources: CompanionFitSources) {}

  /**
   * The mirror opened with a mounted pane, or ended. Every mirror is a fresh hold, so
   * opening forgets the grid the last one asked for and asks again for this one.
   */
  setLive(live: boolean): void {
    if (this.live === live) return
    this.live = live
    this.forget()
    if (live) this.schedule()
    else this.cancel()
  }

  /** The area may have changed; one fit once it settles. */
  areaChanged(): void {
    if (this.live) this.schedule()
  }

  /**
   * The PTY took `grid`. The request is kept while that is the grid asked for (the phone
   * holds the size) and forgotten otherwise, so the next fit asks again rather than
   * assuming the PTY still has the phone's grid.
   */
  applied(grid: CompanionGrid): void {
    if (this.requested !== undefined && !sameGrid(this.requested, grid)) {
      this.requested = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private forget(): void {
    this.requested = undefined
    this.pending = undefined
  }

  private schedule(): void {
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.fit()
    }, FIT_SETTLE_MS)
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private fit(): void {
    if (this.disposed || !this.live) return
    const cell = this.sources.cell()
    if (cell === undefined) return
    const grid = fitCompanionGrid(this.sources.area(), cell)
    if (grid === undefined) return
    if (this.requested !== undefined && sameGrid(this.requested, grid)) return
    this.requested = grid
    if (this.inFlight !== undefined) {
      this.pending = grid
      return
    }
    this.send(grid)
  }

  /** A failed verb forgets its grid, so the next settle asks for it again from a clean state. */
  private send(grid: CompanionGrid): void {
    this.inFlight = grid
    void this.sources.request(grid).then(
      () => this.settle(grid, true),
      () => this.settle(grid, false),
    )
  }

  private settle(grid: CompanionGrid, held: boolean): void {
    this.inFlight = undefined
    if (this.disposed) return
    if (!held && this.requested !== undefined && sameGrid(this.requested, grid)) {
      this.requested = undefined
    }
    const next = this.pending
    this.pending = undefined
    if (next !== undefined) this.send(next)
  }
}

function boundDimension(value: number): number {
  return Math.max(
    MIN_COMPANION_VIEWPORT_DIMENSION,
    Math.min(MAX_COMPANION_VIEWPORT_DIMENSION, value),
  )
}

function sameGrid(left: CompanionGrid, right: CompanionGrid): boolean {
  return left.cols === right.cols && left.rows === right.rows
}
