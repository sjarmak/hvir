import { processClock, type ProcessClock } from './scan-recorder'

/** The system wall clock, which every process on the machine reads alike. */
export type WallClock = () => number

/** Converts marks between one process's clock and the shared wall clock. */
export interface ClockTranslation {
  readonly toWall: (processMark: number) => number
  readonly fromWall: (wallMark: number) => number
}

/**
 * Process clocks are monotonic and stop while the machine sleeps, so two processes' clocks
 * drift apart by the suspends one lived through and the other did not. Only the wall clock
 * is shared, so a mark crosses a process boundary as a wall-clock mark. The offset between
 * the two clocks is sampled here, so take the translation when the marks are sent or
 * received rather than once per process lifetime.
 */
export function translateClock(
  process: ProcessClock = processClock,
  wall: WallClock = Date.now,
): ClockTranslation {
  const wallMs = wall()
  const processMs = process()
  if (!Number.isFinite(wallMs) || !Number.isFinite(processMs))
    throw new Error('Architecture scan clock returned a non-finite time')
  const offset = wallMs - processMs
  return {
    toWall: (processMark) => processMark + offset,
    fromWall: (wallMark) => wallMark - offset,
  }
}
