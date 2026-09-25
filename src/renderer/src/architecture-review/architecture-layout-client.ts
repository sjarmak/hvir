import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'
import type { ArchitectureNodePosition } from './architecture-layout'
import type {
  ArchitectureLayoutRequest,
  ArchitectureLayoutResponse,
} from './architecture-layout-protocol'

interface PendingLayout {
  readonly resolve: (positions: readonly ArchitectureNodePosition[]) => void
  readonly reject: (error: Error) => void
}

let worker: Worker | undefined
let requestId = 0
const pending = new Map<number, PendingLayout>()

export function requestArchitectureLayout(
  input: ArchitectureCanvasLayoutInput,
): Promise<readonly ArchitectureNodePosition[]> {
  worker ??= createWorker()
  requestId += 1
  const request: ArchitectureLayoutRequest = { id: requestId, input }
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject })
    worker!.postMessage(request)
  })
}

function createWorker(): Worker {
  const next = new Worker(new URL('./architecture-layout.worker.ts', import.meta.url), {
    type: 'module',
  })
  next.onmessage = (event: MessageEvent<ArchitectureLayoutResponse>) => {
    const response = event.data
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.type === 'error') request.reject(new Error(response.message))
    else request.resolve(response.positions)
  }
  const fail = () => {
    const error = new Error('Architecture layout worker failed')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    next.terminate()
    worker = undefined
  }
  next.onerror = fail
  next.onmessageerror = fail
  return next
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    worker?.terminate()
    worker = undefined
    const error = new Error('Architecture layout worker replaced')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
}
