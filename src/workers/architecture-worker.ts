import type { WorkerRequest, WorkerResponse } from '../shared/worker-protocol'
import type { ArchitectureCapture } from '../shared/architecture-review'
import { analyzeCaptureTimed } from '../main/architecture-review/timed-analysis'
import { epochClock } from '../main/architecture-review/scan-recorder'
import type { ArchitectureWorkerResult } from '../main/architecture-review/worker'

// Taken after the compiler loaded, so spawn cost includes module evaluation.
const readyEpochMs = epochClock()

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
    const receivedEpochMs = epochClock()
    if (data.type !== 'analyze') throw new Error('Unknown architecture analysis request')
    const { analysis, stages } = analyzeCaptureTimed(data.payload)
    const resultBytes = Buffer.byteLength(JSON.stringify(analysis))
    port.postMessage({
      id: data.id,
      ok: true,
      result: {
        analysis,
        timings: {
          readyEpochMs,
          receivedEpochMs,
          respondedEpochMs: epochClock(),
          resultBytes,
          stages,
        },
      },
    })
  } catch (error) {
    port.postMessage({
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
