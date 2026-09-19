import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CompanionFitController,
  FIT_SETTLE_MS,
  fitCompanionGrid,
  type CompanionGrid,
} from '../src/renderer/companion/src/companion-terminal-fit'
import type { CompanionCellSize } from '../src/renderer/companion/src/companion-terminal-pane'

const CELL: CompanionCellSize = { width: 8, height: 16 }

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
  let requests: CompanionGrid[]
  let controller: CompanionFitController

  beforeEach(() => {
    vi.useFakeTimers()
    area = { width: 376, height: 496 }
    cell = CELL
    requests = []
    controller = new CompanionFitController({
      area: () => area,
      cell: () => cell,
      request: (grid) => requests.push(grid),
    })
  })

  afterEach(() => {
    controller.dispose()
    vi.useRealTimers()
  })

  it('asks once after the settle time when live and Away, and not before either', () => {
    controller.setLive(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS * 2)
    expect(requests).toEqual([])
    controller.setAway(true)
    expect(requests).toEqual([])
    vi.advanceTimersByTime(FIT_SETTLE_MS - 1)
    expect(requests).toEqual([])
    vi.advanceTimersByTime(1)
    expect(requests).toEqual([{ cols: 47, rows: 31 }])
    vi.advanceTimersByTime(FIT_SETTLE_MS * 4)
    expect(requests).toHaveLength(1)
  })

  it('coalesces area changes, skips a size already asked, and asks again for a new one', () => {
    controller.setAway(true)
    controller.setLive(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    controller.areaChanged()
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toEqual([{ cols: 47, rows: 31 }])
    area = { width: 240, height: 320 }
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS - 1)
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS - 1)
    expect(requests).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(requests).toEqual([
      { cols: 47, rows: 31 },
      { cols: 30, rows: 20 },
    ])
  })

  it('goes quiet when the mirror ends or the desktop is focused, and asks afresh on the next Away', () => {
    controller.setAway(true)
    controller.setLive(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toHaveLength(1)
    controller.setAway(false)
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toHaveLength(1)
    // The same size is asked again: the desktop may have taken it back meanwhile.
    controller.setAway(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toHaveLength(2)
    controller.setLive(false)
    controller.areaChanged()
    controller.setAway(false)
    controller.setAway(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toHaveLength(2)
  })

  it('asks nothing while the pane has no cell metrics or the area has no layout', () => {
    cell = undefined
    controller.setAway(true)
    controller.setLive(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    cell = CELL
    area = { width: 0, height: 0 }
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toEqual([])
    area = { width: 376, height: 496 }
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toEqual([{ cols: 47, rows: 31 }])
  })

  it('applied says whether the PTY took the outstanding request, and forgets it otherwise', () => {
    expect(controller.applied({ cols: 132, rows: 43 })).toBe(false)
    controller.setAway(true)
    controller.setLive(true)
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(controller.applied({ cols: 47, rows: 31 })).toBe(true)
    expect(controller.applied({ cols: 47, rows: 31 })).toBe(true)
    // The desktop reclaimed: the request is forgotten, so the same fit asks again later.
    expect(controller.applied({ cols: 132, rows: 43 })).toBe(false)
    expect(controller.applied({ cols: 47, rows: 31 })).toBe(false)
    controller.areaChanged()
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toEqual([
      { cols: 47, rows: 31 },
      { cols: 47, rows: 31 },
    ])
  })

  it('a disposed controller never asks', () => {
    controller.setAway(true)
    controller.setLive(true)
    controller.dispose()
    vi.advanceTimersByTime(FIT_SETTLE_MS)
    expect(requests).toEqual([])
  })
})
