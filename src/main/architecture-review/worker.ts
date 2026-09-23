import type { ArchitectureCapture } from '../../shared/architecture-review'
import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import type { WorkerOperation } from '../../shared/worker-protocol'
import { createWorkerClient, workerPath } from '../worker-host'
export interface ArchitectureWorkerProtocol {
  readonly analyze: WorkerOperation<ArchitectureCapture, ArchitectureAnalysis>
}
/** One request owns one process, so cancellation stops parsing rather than hiding results. */
export async function analyzeInWorker(
  capture: ArchitectureCapture,
  signal: AbortSignal,
): Promise<ArchitectureAnalysis> {
  signal.throwIfAborted()
  const worker = createWorkerClient<ArchitectureWorkerProtocol>(
    workerPath('architecture-worker.js'),
    'hvir-architecture',
  )
  const stop = () => worker.dispose()
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(stop, 60_000)
  try {
    const result = await worker.request('analyze', capture)
    signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    worker.dispose()
  }
}
