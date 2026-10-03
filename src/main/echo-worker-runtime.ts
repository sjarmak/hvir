import type { EchoWorkerProtocol } from '../shared'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import type { WorkbenchRuntime } from './workbench-runtime'

export function ownEchoWorker(
  runtime: Pick<WorkbenchRuntime, 'own'>,
): WorkerClient<EchoWorkerProtocol> {
  return runtime.own(
    'echo worker',
    createWorkerClient<EchoWorkerProtocol>(workerPath('echo-worker.js'), 'hvir-echo'),
    (worker) => worker.dispose(),
  )
}
