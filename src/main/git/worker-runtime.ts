import type { GitWorkerProtocol } from '../../shared/worker-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from '../worker-host'
import type { WorkbenchRuntime } from '../workbench-runtime'
import type { GitMutationAuthorization } from './mutation-authorization'
import { GitWorkerHostRouter, type GitWorkerAuthorityPort } from './worker-host-router'

/** Compose the Git worker with its host broker and application-owned lifetime. */
export function ownGitWorker(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  authority: GitWorkerAuthorityPort,
  authorizations: GitMutationAuthorization,
): WorkerClient<GitWorkerProtocol> {
  const router = new GitWorkerHostRouter({ authority, authorizations })
  return runtime.own(
    'Git worker',
    createWorkerClient<GitWorkerProtocol>(
      workerPath('git-worker.js'),
      'hvir-git',
      (call) => router.route(call),
    ),
    (worker) => worker.dispose(),
  )
}
