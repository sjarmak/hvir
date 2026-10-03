import type { ProjectRegistryPort } from '../project-coordinator'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { ReviewCheckpointCoordinator } from './review-checkpoint-coordinator'
import { GitMutationAuthorization } from './mutation-authorization'
import { ReviewCheckpointHost } from './review-checkpoint-host'
import { ownGitWorker } from './worker-runtime'
import type { GitWorkerAuthorityPort } from './worker-host-router'
import { createFilenameSearchCoordinator } from '../filename-search'
import { ownProjectFileOperationCoordinator } from '../project-file-operations'
import type { ProjectHost } from '../project-host'

export function ownReviewCheckpointRuntime(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  registry: ProjectRegistryPort & GitWorkerAuthorityPort,
  authorizations: GitMutationAuthorization,
  resources: RendererResourceScopes,
  hosts: { hostById(hostId: string): ProjectHost | undefined },
) {
  const host = runtime.own(
    'review checkpoint host',
    new ReviewCheckpointHost(),
    (owned) => owned.dispose(),
  )
  const gitWorker = ownGitWorker(runtime, registry, authorizations, host)
  const reviewCheckpoint = runtime.own(
    'review checkpoint coordinator',
    new ReviewCheckpointCoordinator({
      registry,
      worker: gitWorker,
      checkpoints: host,
      resources,
    }),
    (coordinator) => coordinator.dispose(),
  )
  const filenameSearch = runtime.own(
    'filename search',
    createFilenameSearchCoordinator(gitWorker),
    (search) => search.dispose(),
  )
  const projectFiles = ownProjectFileOperationCoordinator(
    runtime,
    registry,
    hosts,
    resources,
  )
  return { gitWorker, reviewCheckpoint, filenameSearch, projectFiles }
}
