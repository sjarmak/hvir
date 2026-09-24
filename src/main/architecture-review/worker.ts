import type { ArchitectureCapture } from '../../shared/architecture-review'
import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import type { WorkerOperation } from '../../shared/worker-protocol'
import { createWorkerClient, workerPath } from '../worker-host'
import { ArchitectureScanRecorder, processClock } from './scan-recorder'
import { translateClock } from './wall-clock'
import {
  readWorkerTimings,
  type ArchitectureWorkerTimings,
  type WorkerRequestMarks,
  type WorkerRequestWindow,
} from './worker-timings'

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
  const spawnMark = processClock()
  const worker = createWorkerClient<ArchitectureWorkerProtocol>(
    workerPath('architecture-worker.js'),
    'hvir-architecture',
  )
  const stop = () => worker.dispose()
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(stop, 60_000)
  try {
    const result = await worker.request('analyze', capture)
    const window = { spawnMark, returnedMark: processClock() }
    signal.throwIfAborted()
    const marks = readTimingsOrNoteFault(recorder, result.timings, window)
    if (marks) placeWorkerSpans(recorder, capture, marks, window)
    return result.analysis
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    worker.dispose()
  }
}

/**
 * Timings describe the analysis; they are not part of it. Timings main cannot place leave
 * the analysis intact and show in the snapshot as a timing fault instead of worker spans.
 */
function readTimingsOrNoteFault(
  recorder: ArchitectureScanRecorder,
  timings: unknown,
  window: WorkerRequestWindow,
): WorkerRequestMarks | undefined {
  try {
    return readWorkerTimings(timings, window, translateClock())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    recorder.noteTimingFault(`Worker stages not shown: ${reason}`)
    return undefined
  }
}

function placeWorkerSpans(
  recorder: ArchitectureScanRecorder,
  capture: ArchitectureCapture,
  marks: WorkerRequestMarks,
  window: WorkerRequestWindow,
): void {
  const files = [...capture.before, ...capture.after]
  const requestBytes = files.reduce(
    (total, file) =>
      total + Buffer.byteLength(file.path) + Buffer.byteLength(file.content),
    0,
  )
  recorder.place('worker-spawn', window.spawnMark, marks.readyMark, {
    bytes: 0,
    items: 1,
  })
  recorder.place('worker-transfer', marks.readyMark, marks.receivedMark, {
    bytes: requestBytes,
    items: files.length,
  })
  for (const stage of marks.stages)
    recorder.place(stage.stage, stage.startMark, stage.endMark, {
      bytes: stage.bytes,
      items: stage.items,
      ...(stage.side ? { side: stage.side } : {}),
    })
  recorder.place('worker-return', marks.respondedMark, window.returnedMark, {
    bytes: marks.resultBytes,
    items: 1,
  })
}
