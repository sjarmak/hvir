import type { WorkerHostCall, WorkerHostValue } from '../../shared'
import {
  GitMutationAuthorization,
  type GitMutationAuthority,
} from './mutation-authorization'
import { dispatchWorkerHostCall } from './worker-host-broker'
import type { ReviewCheckpointHost } from './review-checkpoint-host'

export interface GitWorkerAuthorityPort {
  authorityForPath(hostId: string, path: string): GitMutationAuthority | undefined
}

export interface GitWorkerHostRouterOptions {
  readonly authority: GitWorkerAuthorityPort
  readonly authorizations: GitMutationAuthorization
  readonly dispatch?: typeof dispatchWorkerHostCall
  readonly checkpoints?: ReviewCheckpointHost
}

/** Routes untrusted worker calls through exact mutation grants, then the Git broker. */
export class GitWorkerHostRouter {
  constructor(private readonly options: GitWorkerHostRouterOptions) {}

  route(call: WorkerHostCall): Promise<WorkerHostValue> {
    return Promise.resolve().then<WorkerHostValue>(() => {
      const path = call.operation === 'exec' ? (call.args[1] ?? '') : call.path.path
      const authority = this.options.authority.authorityForPath(call.hostId, path) ?? null
      if (call.operation === 'reviewCheckpoint') {
        if (
          !authority ||
          !this.options.checkpoints ||
          call.path.hostId !== call.hostId ||
          authority.root.path !== call.path.path
        )
          throw new Error('Checkpoint workspace authority is unavailable')
        return this.options.checkpoints.dispatch(
          call.operationId,
          authority,
          call.request,
        )
      }
      const permissions = this.options.authorizations.permissionsFor(call, authority)
      return (this.options.dispatch ?? dispatchWorkerHostCall)(
        call,
        authority,
        permissions,
      )
    })
  }
}
