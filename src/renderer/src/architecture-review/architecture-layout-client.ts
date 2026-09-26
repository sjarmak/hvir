import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'
import {
  architectureLayoutGraph,
  architectureNodePositions,
  type ArchitectureNodePosition,
} from './architecture-layout'
import type {
  ArchitectureLayoutRegistration,
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
  const request: ArchitectureLayoutRequest = {
    cmd: 'layout',
    id: requestId,
    graph: architectureLayoutGraph(input),
    layoutOptions: {},
    options: {},
  }
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
    if (response.error) request.reject(new Error(errorMessage(response.error)))
    else if (response.data) request.resolve(architectureNodePositions(response.data))
    else request.reject(new Error('Architecture layout worker returned no graph'))
  }
  const fail = (event: Event) => {
    const detail = errorMessage(event)
    const error = new Error(
      detail
        ? `Architecture layout worker failed: ${detail}`
        : 'Architecture layout worker failed',
    )
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    next.terminate()
    worker = undefined
  }
  next.onerror = fail
  next.onmessageerror = fail
  const registration: ArchitectureLayoutRegistration = {
    cmd: 'register',
    id: 0,
    algorithms: ['layered'],
  }
  next.postMessage(registration)
  return next
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if ('message' in value && typeof value.message === 'string') return value.message
  if ('data' in value) return errorMessage(value.data)
  return ''
}

export function disposeArchitectureLayoutWorker(): void {
  worker?.terminate()
  worker = undefined
  const error = new Error('Architecture layout worker replaced')
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

const hot = (import.meta as ImportMeta & {
  readonly hot?: { dispose(callback: () => void): void }
}).hot

if (hot) hot.dispose(disposeArchitectureLayoutWorker)
