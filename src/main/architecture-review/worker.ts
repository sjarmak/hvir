import type { ArchitectureCapture } from '../../shared/architecture-review'
import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import type { WorkerOperation } from '../../shared/worker-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from '../worker-host'
import { ArchitectureScanRecorder, processClock } from './scan-recorder'
import { translateClock } from './wall-clock'
import {
  readWorkerTimings,
  type ArchitectureWorkerTimings,
  type WorkerRequestMarks,
  type WorkerRequestWindow,
} from './worker-timings'

/** Where the worker keeps parsed module facts; in the app, under Electron userData. */
export interface ArchitectureParseCacheLocation {
  readonly directory: string
  readonly maxBytes: number
}
export interface ArchitectureWorkerRequest {
  readonly capture: ArchitectureCapture
  readonly cache?: ArchitectureParseCacheLocation
}
export interface ArchitectureWorkerResult {
  readonly analysis: ArchitectureAnalysis
  readonly timings: ArchitectureWorkerTimings
}
export interface ArchitectureWorkerProtocol {
  readonly analyze: WorkerOperation<ArchitectureWorkerRequest, ArchitectureWorkerResult>
}
type Client = WorkerClient<ArchitectureWorkerProtocol>

export interface ArchitectureAnalysisWorkerOptions {
  readonly cache?: ArchitectureParseCacheLocation
  /** How long an idle warm process is kept before it exits. */
  readonly idleMs?: number
}

const REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_IDLE_MS = 5 * 60_000

/**
 * Runs analyses in a utility process that stays warm between scans, so the compiler loads
 * once and the parse cache's index stays in memory. A request in flight owns its process:
 * cancelling or timing out kills it, so parsing stops, and the next scan starts a new one.
 * Concurrent scans each get their own process; one idle process is kept.
 */
export class ArchitectureAnalysisWorker {
  private idle: { readonly client: Client; readonly expiry: NodeJS.Timeout } | undefined
  private disposed = false

  constructor(private readonly options: ArchitectureAnalysisWorkerOptions = {}) {}

  readonly analyze = async (
    capture: ArchitectureCapture,
    signal: AbortSignal,
    recorder: ArchitectureScanRecorder = new ArchitectureScanRecorder(),
  ): Promise<ArchitectureAnalysis> => {
    signal.throwIfAborted()
    if (this.disposed) throw new Error('Architecture analysis worker disposed')
    const startMark = processClock()
    const warm = this.takeIdle()
    const client = warm ?? spawnClient()
    const stop = () => client.dispose()
    signal.addEventListener('abort', stop, { once: true })
    const timeout = setTimeout(stop, REQUEST_TIMEOUT_MS)
    try {
      const request = this.options.cache
        ? { capture, cache: this.options.cache }
        : { capture }
      const result = await client.request('analyze', request)
      const window = { startMark, returnedMark: processClock(), reused: Boolean(warm) }
      signal.throwIfAborted()
      const marks = readTimingsOrNoteFault(recorder, result.timings, window)
      if (marks) placeWorkerSpans(recorder, capture, marks, window)
      this.keepIdle(client)
      return result.analysis
    } catch (error) {
      client.dispose()
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', stop)
    }
  }

  dispose(): void {
    this.disposed = true
    this.takeIdle()?.dispose()
  }

  private takeIdle(): Client | undefined {
    const idle = this.idle
    if (!idle) return undefined
    this.idle = undefined
    clearTimeout(idle.expiry)
    return idle.client
  }

  private keepIdle(client: Client): void {
    if (this.disposed || this.idle) {
      client.dispose()
      return
    }
    const expiry = setTimeout(() => {
      if (this.idle?.client === client) this.takeIdle()?.dispose()
    }, this.options.idleMs ?? DEFAULT_IDLE_MS)
    expiry.unref?.()
    this.idle = { client, expiry }
  }
}

function spawnClient(): Client {
  return createWorkerClient<ArchitectureWorkerProtocol>(
    workerPath('architecture-worker.js'),
    'hvir-architecture',
  )
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

/** A warm process has no spawn span: its transfer starts when main sent the request. */
function placeWorkerSpans(
  recorder: ArchitectureScanRecorder,
  capture: ArchitectureCapture,
  marks: WorkerRequestMarks,
  window: WorkerRequestWindow,
): void {
  const files = [
    ...capture.before,
    ...capture.after,
    ...capture.configs.before,
    ...capture.configs.after,
  ]
  const requestBytes = files.reduce(
    (total, file) =>
      total + Buffer.byteLength(file.path) + Buffer.byteLength(file.content),
    0,
  )
  if (!window.reused)
    recorder.place('worker-spawn', window.startMark, marks.readyMark, {
      bytes: 0,
      items: 1,
    })
  recorder.place(
    'worker-transfer',
    window.reused ? window.startMark : marks.readyMark,
    marks.receivedMark,
    { bytes: requestBytes, items: files.length },
  )
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
