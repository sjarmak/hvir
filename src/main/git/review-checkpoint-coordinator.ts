import {
  GIT_REVIEW_CHECKPOINT_TYPE,
  hostPathEquals,
  type HostPath,
  type ReviewCheckpointRequest,
  type ReviewCheckpointResult,
} from '../../shared'
import type { GitWorker } from './worker-ports'
import type { ReviewCheckpointHost } from './review-checkpoint-host'
import type { ProjectRegistryPort } from '../project-coordinator'
import type {
  RendererResourceScopes,
  RendererResourceLease,
  RendererOwner,
} from '../renderer-resource-scopes'
import type { CheckpointOperationGrant } from './review-checkpoint-operations'

export interface ReviewCheckpointCoordinatorOptions {
  readonly registry: ProjectRegistryPort
  readonly worker: GitWorker
  readonly checkpoints: ReviewCheckpointHost
  readonly resources: RendererResourceScopes
}

export class ReviewCheckpointCoordinator {
  private readonly grants = new Map<
    CheckpointOperationGrant,
    RendererResourceLease | undefined
  >()
  private readonly cancellations = new Map<CheckpointOperationGrant, () => void>()

  constructor(private readonly options: ReviewCheckpointCoordinatorOptions) {}

  async request(
    owner: RendererOwner,
    operationId: string,
    request: ReviewCheckpointRequest,
  ): Promise<ReviewCheckpointResult> {
    const active = this.options.registry.active
    const snapshot = {
      projectId: active.projectId,
      workspaceId: active.workspaceId,
      root: active.root,
      host: active.host,
    }
    assertActive(snapshot, active, request.root)
    const grant = this.options.checkpoints.begin(
      snapshot,
      request.action === 'capture'
        ? 'capture'
        : request.action === 'clear'
          ? 'clear'
          : 'read',
    )
    this.grants.set(grant, undefined)
    let canceled = false
    const revoke = (): void => {
      canceled = true
      grant.revoke()
    }
    this.cancellations.set(grant, revoke)
    let resource: RendererResourceLease | undefined
    try {
      resource = this.options.resources.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'review-checkpoint',
          root: active.root,
          id: operationId,
        },
        revoke,
      )
      this.grants.set(grant, resource)
      return await this.options.worker
        .request(GIT_REVIEW_CHECKPOINT_TYPE, { ...request, operationId: grant.id })
        .then((result) => {
          assertActive(snapshot, this.options.registry.active, request.root)
          if (canceled) throw new Error('Checkpoint operation was canceled')
          return result
        })
    } catch (error) {
      revoke()
      resource?.release()
      throw error
    } finally {
      finish(resource, grant, this.grants, this.cancellations)
    }
  }

  cancel(owner: RendererOwner, operationId: string): Promise<void> {
    return this.options.resources
      .disposeResource(owner, 'review-checkpoint', operationId)
      .then(() => undefined)
  }

  dispose(): void {
    for (const [grant, resource] of this.grants) {
      this.cancellations.get(grant)?.()
      void resource?.dispose()
    }
    this.grants.clear()
    this.cancellations.clear()
  }
}

function assertActive(
  snapshot: {
    readonly projectId: string
    readonly workspaceId: string
    readonly root: HostPath
    readonly host: unknown
  },
  active: {
    readonly projectId: string
    readonly workspaceId: string
    readonly root: HostPath
    readonly host: unknown
  },
  requested: HostPath,
): void {
  if (
    snapshot.projectId !== active.projectId ||
    snapshot.workspaceId !== active.workspaceId ||
    snapshot.host !== active.host ||
    !hostPathEquals(snapshot.root, active.root) ||
    !hostPathEquals(active.root, requested)
  )
    throw new Error('Checkpoint workspace is no longer active')
}

function finish(
  resource: RendererResourceLease | undefined,
  grant: CheckpointOperationGrant,
  grants: Map<CheckpointOperationGrant, RendererResourceLease | undefined>,
  cancellations: Map<CheckpointOperationGrant, () => void>,
): void {
  grant.revoke()
  resource?.release()
  grants.delete(grant)
  cancellations.delete(grant)
}
