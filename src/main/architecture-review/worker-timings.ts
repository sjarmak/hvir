import { ARCHITECTURE_CLOCK_SKEW_TOLERANCE_MS } from './scan-recorder'
import type { EpochStage } from './timed-analysis'

/** Wall-clock marks the worker reports so main can place its spans on the scan timeline. */
export interface ArchitectureWorkerTimings {
  /** The worker module finished loading, including the TypeScript compiler. */
  readonly readyEpochMs: number
  readonly receivedEpochMs: number
  readonly respondedEpochMs: number
  /** Serialized size of the analysis sent back to main. */
  readonly resultBytes: number
  readonly stages: readonly EpochStage[]
}

/** Main's own wall-clock marks around one worker request. */
export interface WorkerRequestWindow {
  readonly spawnEpochMs: number
  readonly returnedEpochMs: number
}

/**
 * Accepts only timings a worker could have produced for this request: well-formed marks in
 * the order spawn, ready, received, stages, responded, returned, allowing cross-process
 * clock skew. Relative milliseconds, reordered marks and future stamps are refused.
 */
export function assertWorkerTimings(
  value: unknown,
  window: WorkerRequestWindow,
): asserts value is ArchitectureWorkerTimings {
  if (!isWorkerTimings(value) || !inRequestOrder(value, window))
    throw new Error('Architecture worker returned malformed timings')
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
    timings.stages.every(isEpochStage)
  )
}

function isEpochStage(value: unknown): value is EpochStage {
  if (typeof value !== 'object' || value === null) return false
  const stage = value as Partial<Record<keyof EpochStage, unknown>>
  return (
    (stage.stage === 'parse' || stage.stage === 'compare') &&
    (stage.side === undefined || stage.side === 'baseline' || stage.side === 'current') &&
    isFiniteNumber(stage.startEpochMs) &&
    isFiniteNumber(stage.endEpochMs) &&
    isCount(stage.bytes) &&
    isCount(stage.items)
  )
}

function inRequestOrder(
  timings: ArchitectureWorkerTimings,
  window: WorkerRequestWindow,
): boolean {
  const stagesInOrder = timings.stages.every(
    (stage) =>
      notAfter(timings.receivedEpochMs, stage.startEpochMs) &&
      notAfter(stage.startEpochMs, stage.endEpochMs) &&
      notAfter(stage.endEpochMs, timings.respondedEpochMs),
  )
  return (
    stagesInOrder &&
    notAfter(window.spawnEpochMs, timings.readyEpochMs) &&
    notAfter(timings.readyEpochMs, timings.receivedEpochMs) &&
    notAfter(timings.receivedEpochMs, timings.respondedEpochMs) &&
    notAfter(timings.respondedEpochMs, window.returnedEpochMs)
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
