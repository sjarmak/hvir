import type { WorkerRequest, WorkerResponse } from '../shared/worker-protocol'
import type { ArchitectureCapture } from '../shared/architecture-review'
import { analyzeArchitectureCapture } from '../main/architecture-review/analysis'
interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: WorkerRequest<ArchitectureCapture> }) => void,
  ): void
  postMessage(message: WorkerResponse): void
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('Architecture analysis requires a utility process')
port.on('message', ({ data }) => {
  try {
    if (data.type !== 'analyze') throw new Error('Unknown architecture analysis request')
    port.postMessage({
      id: data.id,
      ok: true,
      result: analyzeArchitectureCapture(data.payload),
    })
  } catch (error) {
    port.postMessage({
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
