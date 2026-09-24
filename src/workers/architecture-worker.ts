import type { WorkerRequest, WorkerResponse } from '../shared/worker-protocol'
import type { ArchitectureCapture } from '../shared/architecture-review'
import { analyzeCaptureTimed } from '../main/architecture-review/timed-analysis'
import { processClock } from '../main/architecture-review/scan-recorder'
import { translateClock } from '../main/architecture-review/wall-clock'
import { reportWorkerTimings } from '../main/architecture-review/worker-timings'
import type { ArchitectureWorkerResult } from '../main/architecture-review/worker'

// Taken after the compiler loaded, so spawn cost includes module evaluation.
const readyMark = processClock()

interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: WorkerRequest<ArchitectureCapture> }) => void,
  ): void
  postMessage(message: WorkerResponse<ArchitectureWorkerResult>): void
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('Architecture analysis requires a utility process')
port.on('message', ({ data }) => {
  try {
    const receivedMark = processClock()
    if (data.type !== 'analyze') throw new Error('Unknown architecture analysis request')
    const { analysis, stages } = analyzeCaptureTimed(data.payload)
    // Marked before sizing the result, so serializing it counts toward worker-return.
    const respondedMark = processClock()
    const resultBytes = Buffer.byteLength(JSON.stringify(analysis))
    const marks = { readyMark, receivedMark, respondedMark, resultBytes, stages }
    port.postMessage({
      id: data.id,
      ok: true,
      result: { analysis, timings: reportWorkerTimings(marks, translateClock()) },
    })
  } catch (error) {
    port.postMessage({
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
