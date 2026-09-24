import { ARCHITECTURE_CLOCK_SKEW_TOLERANCE_MS } from './scan-recorder'
import type { TimedStage } from './timed-analysis'
import type { ClockTranslation } from './wall-clock'

/** One worker stage as sent to main, marked on the shared wall clock. */
export interface WorkerStageTiming {
  readonly stage: TimedStage['stage']
  readonly side?: TimedStage['side']
  readonly startEpochMs: number
  readonly endEpochMs: number
  readonly bytes: number
  readonly items: number
}

/**
 * Wall-clock marks the worker reports so main can place its spans on the scan timeline.
 * Process clocks drift apart across system sleep, so marks cross the boundary only as
 * wall-clock time (see `wall-clock.ts`).
 */
export interface ArchitectureWorkerTimings {
  /** The worker module finished loading, including the TypeScript compiler. */
  readonly readyEpochMs: number
  readonly receivedEpochMs: number
  readonly respondedEpochMs: number
  /** Serialized size of the analysis sent back to main. */
  readonly resultBytes: number
  readonly stages: readonly WorkerStageTiming[]
}

/** The marks of one worker request on a single process's clock. */
export interface WorkerRequestMarks {
  readonly readyMark: number
  readonly receivedMark: number
  readonly respondedMark: number
  readonly resultBytes: number
  readonly stages: readonly TimedStage[]
}

/** Main's own process-clock marks around one worker request. */
export interface WorkerRequestWindow {
  readonly spawnMark: number
  readonly returnedMark: number
}

/** Worker side: carries its process-clock marks to main as wall-clock marks. */
export function reportWorkerTimings(
  marks: WorkerRequestMarks,
  clock: ClockTranslation,
): ArchitectureWorkerTimings {
  return {
    readyEpochMs: clock.toWall(marks.readyMark),
    receivedEpochMs: clock.toWall(marks.receivedMark),
    respondedEpochMs: clock.toWall(marks.respondedMark),
    resultBytes: marks.resultBytes,
    stages: marks.stages.map(({ startMark, endMark, ...stage }) => ({
      ...stage,
      startEpochMs: clock.toWall(startMark),
      endEpochMs: clock.toWall(endMark),
    })),
  }
}

/**
 * Main side: accepts only timings a worker could have produced for this request and
 * returns them on main's clock. Every mark must lie inside the window main observed, in the
 * order ready, received, stages, responded, allowing the translation's skew. Relative
 * milliseconds, reordered marks and future stamps are refused.
 */
export function readWorkerTimings(
  value: unknown,
  window: WorkerRequestWindow,
  clock: ClockTranslation,
): WorkerRequestMarks {
  if (!isWorkerTimings(value)) throw malformed()
  const marks: WorkerRequestMarks = {
    readyMark: clock.fromWall(value.readyEpochMs),
    receivedMark: clock.fromWall(value.receivedEpochMs),
    respondedMark: clock.fromWall(value.respondedEpochMs),
    resultBytes: value.resultBytes,
    stages: value.stages.map(({ startEpochMs, endEpochMs, ...stage }) => ({
      ...stage,
      startMark: clock.fromWall(startEpochMs),
      endMark: clock.fromWall(endEpochMs),
    })),
  }
  if (!inRequestOrder(marks, window)) throw malformed()
  return marks
}

function malformed(): Error {
  return new Error('Architecture worker returned malformed timings')
}

function isWorkerTimings(value: unknown): value is ArchitectureWorkerTimings {
  if (typeof value !== 'object' || value === null) return false
  const timings = value as Partial<Record<keyof ArchitectureWorkerTimings, unknown>>
  return (
    [timings.readyEpochMs, timings.receivedEpochMs, timings.respondedEpochMs].every(
      isFiniteNumber,
    ) &&
    isCount(timings.resultBytes) &&
    Array.isArray(timings.stages) &&
    timings.stages.every(isStageTiming)
  )
}

function isStageTiming(value: unknown): value is WorkerStageTiming {
  if (typeof value !== 'object' || value === null) return false
  const stage = value as Partial<Record<keyof WorkerStageTiming, unknown>>
  return (
    (stage.stage === 'parse' || stage.stage === 'compare') &&
    (stage.side === undefined || stage.side === 'baseline' || stage.side === 'current') &&
    isFiniteNumber(stage.startEpochMs) &&
    isFiniteNumber(stage.endEpochMs) &&
    isCount(stage.bytes) &&
    isCount(stage.items)
  )
}

function inRequestOrder(marks: WorkerRequestMarks, window: WorkerRequestWindow): boolean {
  const stagesInOrder = marks.stages.every(
    (stage) =>
      notAfter(marks.receivedMark, stage.startMark) &&
      notAfter(stage.startMark, stage.endMark) &&
      notAfter(stage.endMark, marks.respondedMark),
  )
  const all = [
    marks.readyMark,
    marks.receivedMark,
    marks.respondedMark,
    ...marks.stages.flatMap((stage) => [stage.startMark, stage.endMark]),
  ]
  return (
    stagesInOrder &&
    all.every(
      (mark) => notAfter(window.spawnMark, mark) && notAfter(mark, window.returnedMark),
    ) &&
    notAfter(marks.readyMark, marks.receivedMark) &&
    notAfter(marks.receivedMark, marks.respondedMark)
  )
}

function notAfter(earlier: number, later: number): boolean {
  return earlier <= later + ARCHITECTURE_CLOCK_SKEW_TOLERANCE_MS
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
