import type { ArchitectureCapture } from '../../shared/architecture-review'
import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import type { WorkerOperation } from '../../shared/worker-protocol'
import { createWorkerClient, workerPath } from '../worker-host'
import { ArchitectureScanRecorder, epochClock } from './scan-recorder'
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
export interface ArchitectureWorkerResult {
  readonly analysis: ArchitectureAnalysis
  readonly timings: ArchitectureWorkerTimings
}
export interface ArchitectureWorkerProtocol {
  readonly analyze: WorkerOperation<ArchitectureCapture, ArchitectureWorkerResult>
}
/** One request owns one process, so cancellation stops parsing rather than hiding results. */
export async function analyzeInWorker(
  capture: ArchitectureCapture,
  signal: AbortSignal,
  recorder: ArchitectureScanRecorder = new ArchitectureScanRecorder(),
): Promise<ArchitectureAnalysis> {
  signal.throwIfAborted()
  const spawnEpochMs = epochClock()
  const worker = createWorkerClient<ArchitectureWorkerProtocol>(
    workerPath('architecture-worker.js'),
    'hvir-architecture',
  )
  const stop = () => worker.dispose()
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(stop, 60_000)
  try {
    const result = await worker.request('analyze', capture)
    const returnedEpochMs = epochClock()
    signal.throwIfAborted()
    placeWorkerSpans(recorder, capture, result.timings, spawnEpochMs, returnedEpochMs)
    return result.analysis
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    worker.dispose()
  }
}

function placeWorkerSpans(
  recorder: ArchitectureScanRecorder,
  capture: ArchitectureCapture,
  timings: ArchitectureWorkerTimings,
  spawnEpochMs: number,
  returnedEpochMs: number,
): void {
  assertTimings(timings)
  const files = [...capture.before, ...capture.after]
  const requestBytes = files.reduce(
    (total, file) =>
      total + Buffer.byteLength(file.path) + Buffer.byteLength(file.content),
    0,
  )
  recorder.place('worker-spawn', spawnEpochMs, timings.readyEpochMs, {
    bytes: 0,
    items: 1,
  })
  recorder.place('worker-transfer', timings.readyEpochMs, timings.receivedEpochMs, {
    bytes: requestBytes,
    items: files.length,
  })
  for (const stage of timings.stages)
    recorder.place(stage.stage, stage.startEpochMs, stage.endEpochMs, {
      bytes: stage.bytes,
      items: stage.items,
      ...(stage.side ? { side: stage.side } : {}),
    })
  recorder.place('worker-return', timings.respondedEpochMs, returnedEpochMs, {
    bytes: timings.resultBytes,
    items: 1,
  })
}

function assertTimings(timings: ArchitectureWorkerTimings | undefined): void {
  const marks = [
    timings?.readyEpochMs,
    timings?.receivedEpochMs,
    timings?.respondedEpochMs,
    timings?.resultBytes,
  ]
  const stages: readonly unknown[] | undefined = Array.isArray(timings?.stages)
    ? timings.stages
    : undefined
  if (
    marks.some((mark) => typeof mark !== 'number') ||
    !stages?.every((stage) => isEpochStage(stage))
  )
    throw new Error('Architecture worker returned malformed timings')
}

function isEpochStage(value: unknown): value is EpochStage {
  if (typeof value !== 'object' || value === null) return false
  const stage = value as Partial<Record<keyof EpochStage, unknown>>
  return (
    (stage.stage === 'parse' || stage.stage === 'compare') &&
    [stage.startEpochMs, stage.endEpochMs, stage.bytes, stage.items].every(
      (field) => typeof field === 'number',
    )
  )
}
