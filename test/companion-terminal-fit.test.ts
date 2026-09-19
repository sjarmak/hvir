import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CompanionFitController,
  FIT_SETTLE_MS,
  fitCompanionGrid,
  type CompanionGrid,
  type CompanionResizeAnswer,
} from '../src/renderer/companion/src/companion-terminal-fit'
import type { CompanionCellSize } from '../src/renderer/companion/src/companion-terminal-pane'

const CELL: CompanionCellSize = { width: 8, height: 16 }
const ACCEPTED: CompanionResizeAnswer = { outcome: 'accepted' }
const REFUSED: CompanionResizeAnswer = { outcome: 'refused', reason: 'desktop-focused' }

interface Deferred {
  readonly grid: CompanionGrid
  readonly answer: (answer: CompanionResizeAnswer) => void
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
  let answers: CompanionResizeAnswer[]
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
    answers = []
    controller = new CompanionFitController({
      area: () => area,
      cell: () => cell,
      request: (grid) =>
        new Promise((resolve, reject) => {
          requests.push({ grid, answer: resolve, fail: reject })
        }),
      answered: (answer) => answers.push(answer),
    })
  })

  afterEach(() => {
    controller.dispose()
    vi.useRealTimers()
  })

  it('asks once after the settle time when live and Away, and not before either', async () => {
    controller.setLive(true)
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 2)
    expect(grids()).toEqual([])
    controller.setAway(true)
    expect(grids()).toEqual([])
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 1)
    expect(grids()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(grids()).toEqual([{ cols: 47, rows: 31 }])
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 4)
    expect(grids()).toHaveLength(1)
    requests[0]!.answer(ACCEPTED)
    await settle()
    expect(answers).toEqual([ACCEPTED])
  })

  it('coalesces area changes, skips a size already asked, and asks again for a new one', async () => {
    controller.setAway(true)
    controller.setLive(true)
    await settle()
    requests[0]!.answer(ACCEPTED)
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

  it('goes quiet when the mirror ends or the desktop is focused, and asks afresh on the next Away', async () => {
    controller.setAway(true)
    controller.setLive(true)
    await settle()
    requests[0]!.answer(ACCEPTED)
    await settle()
    expect(grids()).toHaveLength(1)
    controller.setAway(false)
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)
    // The same size is asked again: the desktop may have taken it back meanwhile.
    controller.setAway(true)
    await settle()
    expect(grids()).toHaveLength(2)
    requests[1]!.answer(ACCEPTED)
    controller.setLive(false)
    controller.areaChanged()
    controller.setAway(false)
    controller.setAway(true)
    await settle()
    expect(grids()).toHaveLength(2)
  })

  it('asks nothing while the pane has no cell metrics or the area has no layout', async () => {
    cell = undefined
    controller.setAway(true)
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
    controller.setAway(true)
    controller.setLive(true)
    await settle()
    requests[0]!.answer(ACCEPTED)
    await settle()
    // The phone's own grid arrived: the same fit has nothing new to ask.
    controller.applied({ cols: 47, rows: 31 })
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)
    // The desktop reclaimed: the request is forgotten, so the same fit asks again.
    controller.applied({ cols: 132, rows: 43 })
    controller.areaChanged()
    await settle()
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 47, rows: 31 },
    ])
  })

  it('sends one request at a time: a grid fitted meanwhile waits, then goes out, and only its answer is reported', async () => {
    controller.setAway(true)
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

    requests[0]!.answer(REFUSED)
    await settle()
    expect(answers).toEqual([])
    expect(grids()).toEqual([
      { cols: 47, rows: 31 },
      { cols: 40, rows: 25 },
    ])
    requests[1]!.answer(ACCEPTED)
    await settle()
    expect(answers).toEqual([ACCEPTED])
    expect(grids()).toHaveLength(2)
  })

  it('an answer for a grid the desktop is no longer asked for is dropped', async () => {
    controller.setAway(true)
    controller.setLive(true)
    await settle()
    controller.setAway(false)
    requests[0]!.answer(REFUSED)
    await settle()
    expect(answers).toEqual([])
  })

  it('a request that fails resolves to no answer and lets the next grid through', async () => {
    controller.setAway(true)
    controller.setLive(true)
    await settle()
    area = { width: 240, height: 320 }
    controller.areaChanged()
    await settle()
    requests[0]!.fail(new Error('network'))
    await settle()
    expect(grids()).toHaveLength(2)
    requests[1]!.answer(undefined)
    await settle()
    expect(answers).toEqual([undefined])
  })

  it('a disposed controller never asks and never reports', async () => {
    controller.setAway(true)
    controller.setLive(true)
    await settle()
    controller.dispose()
    requests[0]!.answer(ACCEPTED)
    controller.areaChanged()
    await settle()
    expect(grids()).toHaveLength(1)
    expect(answers).toEqual([])
  })
})
