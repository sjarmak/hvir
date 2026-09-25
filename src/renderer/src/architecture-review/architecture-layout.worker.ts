import { layoutArchitectureGraph } from './architecture-layout'
import type {
  ArchitectureLayoutRequest,
  ArchitectureLayoutResponse,
} from './architecture-layout-protocol'

self.onmessage = (event: MessageEvent<ArchitectureLayoutRequest>): void => {
  void runLayout(event.data)
}

async function runLayout(request: ArchitectureLayoutRequest): Promise<void> {
  try {
    post({
      id: request.id,
      type: 'layout',
      positions: await layoutArchitectureGraph(request.input),
    })
  } catch (error) {
    post({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function post(response: ArchitectureLayoutResponse): void {
  self.postMessage(response)
}
