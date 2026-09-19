/**
 * The phone's fit (ADR-052): how many whole cells of the pane's fixed font the
 * terminal area holds, and when to ask the desktop for that grid. The desktop
 * owns the PTY's size while any of its windows is focused, so a request goes
 * out only while the mirror is live and the snapshot says Away: once when both
 * hold, and once more after the area settles following a change (orientation,
 * the soft keyboard, a header line appearing). The PTY's answer arrives as a
 * geometry frame like any other; `applied` tells the caller whether that frame
 * is the phone's own grid, so the surface can render it unscaled.
 *
 * Nothing here talks to the network or the DOM; the mount supplies the area,
 * the cell, and the verb.
 */
import {
  MAX_COMPANION_RESIZE_DIMENSION,
  MIN_COMPANION_RESIZE_DIMENSION,
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
  /** Asks the desktop for this grid. */
  readonly request: (grid: CompanionGrid) => void
}

export class CompanionFitController {
  private live = false
  private away = false
  private requested?: CompanionGrid
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly sources: CompanionFitSources) {}

  /** The mirror opened with a mounted pane, or ended. Ending forgets the request. */
  setLive(live: boolean): void {
    if (this.live === live) return
    this.live = live
    this.requested = undefined
    if (live) this.schedule()
    else this.cancel()
  }

  /** What the snapshot says. A fresh Away asks again even for a size asked before. */
  setAway(away: boolean): void {
    if (this.away === away) return
    this.away = away
    this.requested = undefined
    if (away) this.schedule()
    else this.cancel()
  }

  /** The area may have changed; one fit once it settles. */
  areaChanged(): void {
    if (this.live && this.away) this.schedule()
  }

  /**
   * The PTY took `grid`. True when that is the phone's outstanding request, so
   * the phone holds the size; otherwise the request is forgotten so the next
   * fit asks again rather than assuming the desktop still has it.
   */
  applied(grid: CompanionGrid): boolean {
    if (this.requested !== undefined && sameGrid(this.requested, grid)) return true
    this.requested = undefined
    return false
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
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
    if (this.disposed || !this.live || !this.away) return
    const cell = this.sources.cell()
    if (cell === undefined) return
    const grid = fitCompanionGrid(this.sources.area(), cell)
    if (grid === undefined) return
    if (this.requested !== undefined && sameGrid(this.requested, grid)) return
    this.requested = grid
    this.sources.request(grid)
  }
}

function boundDimension(value: number): number {
  return Math.max(
    MIN_COMPANION_RESIZE_DIMENSION,
    Math.min(MAX_COMPANION_RESIZE_DIMENSION, value),
  )
}

function sameGrid(left: CompanionGrid, right: CompanionGrid): boolean {
  return left.cols === right.cols && left.rows === right.rows
}
