import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CompanionFitController,
  FIT_SETTLE_MS,
  fitCompanionGrid,
  type CompanionGrid,
} from '../src/renderer/companion/src/companion-terminal-fit'
import type { CompanionCellSize } from '../src/renderer/companion/src/companion-terminal-pane'

const CELL: CompanionCellSize = { width: 8, height: 16 }
interface Deferred {
  readonly grid: CompanionGrid
  /** The listener took this grid. */
  readonly held: () => void
  readonly fail: (error: unknown) => void
}

describe('fitCompanionGrid', () => {
  it('floors whole cells into the area', () => {
    expect(fitCompanionGrid({ width: 376, height: 496 }, CELL)).toEqual({
      cols: 47,
      rows: 31,
    })
    expect(fitCompanionGrid({ width: 383, height: 511 }, CELL)).toEqual({
      cols: 47,
      rows: 31,
    })
    expect(
      fitCompanionGrid({ width: 100, height: 50 }, { width: 7.5, height: 17 }),
    ).toEqual({
      cols: 13,
      rows: 2,
    })
  })

  it('clamps to the PTY dimension bounds the listener accepts', () => {
    expect(fitCompanionGrid({ width: 9, height: 17 }, CELL)).toEqual({ cols: 2, rows: 2 })
    expect(fitCompanionGrid({ width: 9000, height: 20000 }, CELL)).toEqual({
      cols: 1000,
      rows: 1000,
    })
  })

  it('has no grid while the area or the cell has no layout', () => {
    expect(fitCompanionGrid({ width: 0, height: 496 }, CELL)).toBeUndefined()
    expect(fitCompanionGrid({ width: 376, height: 0 }, CELL)).toBeUndefined()
    expect(
      fitCompanionGrid({ width: 376, height: 496 }, { width: 0, height: 16 }),
    ).toBeUndefined()
    expect(
      fitCompanionGrid({ width: Number.NaN, height: 496 }, { width: 8, height: 16 }),
    ).toBeUndefined()
  })
})

describe('CompanionFitController', () => {
  let area = { width: 376, height: 496 }
  let cell: CompanionCellSize | undefined = CELL
  /** Every request, in order; each stays open until the test answers it. */
  let requests: Deferred[]
  let controller: CompanionFitController

  const grids = (): CompanionGrid[] => requests.map((request) => request.grid)
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    area = { width: 376, height: 496 }
    cell = CELL
    requests = []
    controller = new CompanionFitController({
      area: () => area,
      cell: () => cell,
      request: (grid) =>
        new Promise((resolve, reject) => {
          requests.push({ grid, held: () => resolve(), fail: reject })
        }),
    })
  })

  afterEach(() => {
    controller.dispose()
    vi.useRealTimers()
  })

  it('asks once after the settle time when the mirror is live, and not before', async () => {
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 2)
    expect(grids()).toEqual([])
    controller.setLive(true)
    expect(grids()).toEqual([])
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 1)
    expect(grids()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(grids()).toEqual([{ cols: 47, rows: 31 }])
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 4)
    expect(grids()).toHaveLength(1)
  })

  it('coalesces area changes, skips a size already asked, and asks again for a new one', async () => {
    controller.setLive(true)
    await settle()
    requests[0]!.held()
    controller.areaChanged()
    controller.areaChanged()
    await settle()
    expect(grids()).toEqual([{ cols: 47, rows: 31 }])
    area = { width: 240, height: 320 }
    controller.areaChanged()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 1)
    controller.areaChanged()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 1)
    expect(grids()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 30, rows: 20 },
    ])
  })

  it('goes quiet when the mirror ends and asks afresh for the next one', async () => {
    controller.setLive(true)
    await settle()
    requests[0]!.held()
    await settle()
    expect(grids()).toHaveLength(1)
    controller.setLive(false)
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)
    // Every mirror is a fresh hold, so the same size is asked for again.
    controller.setLive(true)
    await settle()
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 47, rows: 31 },
    ])
  })

  it("never consults the desktop's focus: nothing but live and the area decides", async () => {
    // The controller has no focus input at all; the seam is the whole proof.
    expect('setAway' in controller).toBe(false)
    controller.setLive(true)
    await settle()
    expect(grids()).toEqual([{ cols: 47, rows: 31 }])
  })

  it('asks nothing while the pane has no cell metrics or the area has no layout', async () => {
    cell = undefined
    controller.setLive(true)
    await settle()
    cell = CELL
    area = { width: 0, height: 0 }
    controller.areaChanged()
    await settle()
    expect(grids()).toEqual([])
    area = { width: 376, height: 496 }
    controller.areaChanged()
    await settle()
    expect(grids()).toEqual([{ cols: 47, rows: 31 }])
  })

  it('keeps the request while the PTY reports that grid and forgets it when another lands', async () => {
    controller.applied({ cols: 132, rows: 43 })
    controller.setLive(true)
    await settle()
    requests[0]!.held()
    await settle()
    // The phone's own grid arrived: the same fit has nothing new to ask.
    controller.applied({ cols: 47, rows: 31 })
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)
    // The PTY took some other size: the request is forgotten, so the fit asks again.
    controller.applied({ cols: 132, rows: 43 })
    controller.areaChanged()
    await settle()
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 47, rows: 31 },
    ])
  })

  it('sends one request at a time: a grid fitted meanwhile waits, then goes out', async () => {
    controller.setLive(true)
    await settle()
    expect(grids()).toEqual([{ cols: 47, rows: 31 }])

    // Two area changes while the first request is in flight: the latest grid waits.
    area = { width: 240, height: 320 }
    controller.areaChanged()
    await settle()
    area = { width: 320, height: 400 }
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)

    requests[0]!.held()
    await settle()
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 40, rows: 25 },
    ])
    requests[1]!.held()
    await settle()
    expect(grids()).toHaveLength(2)
  })

  it('a request that fails is forgotten, so the same grid goes out again at the next settle', async () => {
    controller.setLive(true)
    await settle()
    requests[0]!.fail(new Error('network'))
    await settle()
    expect(grids()).toHaveLength(1)
    controller.areaChanged()
    await settle()
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 47, rows: 31 },
    ])
  })

  it('a failure behind a waiting grid lets that grid through', async () => {
    controller.setLive(true)
    await settle()
    area = { width: 240, height: 320 }
    controller.areaChanged()
    await settle()
    requests[0]!.fail(new Error('network'))
    await settle()
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 30, rows: 20 },
    ])
  })

  it('a disposed controller never asks again', async () => {
    controller.setLive(true)
    await settle()
    controller.dispose()
    requests[0]!.held()
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)
  })
})
