/**
 * The phone's fit (ADR-052): how many whole cells of the pane's fixed font the
 * terminal area holds, and when to ask the desktop for that grid. The desktop
 * owns the PTY's size while any of its windows is focused, so a request goes
 * out only while the mirror is live and the snapshot says Away: once when both
 * hold, and once more after the area settles following a change (orientation,
 * the soft keyboard, a header line appearing). At most one request is in
 * flight; a grid fitted meanwhile waits and goes out when the first settles,
 * so the PTY ends at the latest grid, and only the answer to the latest grid
 * is reported. The PTY's new size arrives as a geometry frame like any other;
 * `applied` keeps the request while that frame matches it and forgets it when
 * the desktop has taken the size instead.
 *
 * Nothing here talks to the network or the DOM; the mount supplies the area,
 * the cell, and the verb.
 */
import {
  MAX_COMPANION_RESIZE_DIMENSION,
  MIN_COMPANION_RESIZE_DIMENSION,
  type CompanionResizeResponse,
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

/** What the desktop said, or nothing when the request could not be made or failed. */
export type CompanionResizeAnswer = CompanionResizeResponse | undefined

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
  /** Asks the desktop for this grid and resolves with its answer. */
  readonly request: (grid: CompanionGrid) => Promise<CompanionResizeAnswer>
  /** The answer to the latest grid asked for; an answer to a grid superseded meanwhile is dropped. */
  readonly answered: (answer: CompanionResizeAnswer) => void
}

export class CompanionFitController {
  private live = false
  private away = false
  /** The latest grid wanted: in flight, waiting behind it, or already taken. */
  private requested?: CompanionGrid
  private inFlight?: CompanionGrid
  private pending?: CompanionGrid
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly sources: CompanionFitSources) {}

  /** The mirror opened with a mounted pane, or ended. Ending forgets the request. */
  setLive(live: boolean): void {
    if (this.live === live) return
    this.live = live
    this.forget()
    if (live) this.schedule()
    else this.cancel()
  }

  /** What the snapshot says. A fresh Away asks again even for a size asked before. */
  setAway(away: boolean): void {
    if (this.away === away) return
    this.away = away
    this.forget()
    if (away) this.schedule()
    else this.cancel()
  }

  /** The area may have changed; one fit once it settles. */
  areaChanged(): void {
    if (this.live && this.away) this.schedule()
  }

  /**
   * The PTY took `grid`. The request is kept while that is the grid asked for
   * (the phone holds the size) and forgotten otherwise, so the next fit asks
   * again rather than assuming the desktop still has the phone's grid.
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
    if (this.disposed || !this.live || !this.away) return
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

  /** The verb's own failures resolve to no answer; a rejection is treated the same so the door reopens. */
  private send(grid: CompanionGrid): void {
    this.inFlight = grid
    void this.sources.request(grid).then(
      (answer) => this.settle(grid, answer),
      () => this.settle(grid, undefined),
    )
  }

  private settle(grid: CompanionGrid, answer: CompanionResizeAnswer): void {
    this.inFlight = undefined
    if (this.disposed) return
    const next = this.pending
    this.pending = undefined
    if (next !== undefined) {
      this.send(next)
      return
    }
    if (this.requested !== undefined && sameGrid(this.requested, grid)) {
      this.sources.answered(answer)
    }
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
