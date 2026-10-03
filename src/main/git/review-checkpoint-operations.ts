import { randomUUID } from 'node:crypto'
import { hostPath, hostPathEquals, type HostPath } from '../../shared'

export type CheckpointOperationKind = 'read' | 'capture' | 'clear'

export interface CheckpointOperationScope {
  readonly projectId: string
  readonly root: HostPath
}

export interface CheckpointOperationGrant {
  readonly id: string
  readonly signal: AbortSignal
  revoke(): void
}

export interface CheckpointOperationLease {
  readonly kind: CheckpointOperationKind
  readonly signal: AbortSignal
  assertActive(): void
  assertCapture(): void
  charge(cost: {
    readonly files?: number
    readonly bytes?: number
    readonly trees?: number
  }): void
  finishRef(): void
}

interface OperationRecord {
  readonly scope: CheckpointOperationScope
  readonly kind: CheckpointOperationKind
  readonly controller: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  readonly expiresAt: number
  readonly busy: boolean
  readonly terminal: boolean
  readonly files: number
  readonly bytes: number
  readonly trees: number
}

export const CHECKPOINT_OPERATION_TIMEOUT_MS = 120_000
export const CHECKPOINT_TOTAL_BYTE_LIMIT = 256 * 1024 * 1024
const MAX_OPERATIONS = 32
const MAX_FILE_READS = 10_000
const MAX_TREES = 10_000

export class ReviewCheckpointOperations {
  private readonly operations = new Map<string, OperationRecord>()
  private disposed = false

  begin(
    scope: CheckpointOperationScope,
    kind: CheckpointOperationKind,
  ): CheckpointOperationGrant {
    if (this.disposed) throw new Error('Review checkpoint operations disposed')
    assertScope(scope)
    if (this.operations.size >= MAX_OPERATIONS)
      throw new Error('Too many checkpoint operations')
    if (
      kind !== 'read' &&
      [...this.operations.values()].some(
        (operation) => operation.kind !== 'read' && sameScope(operation.scope, scope),
      )
    ) {
      throw new Error('A checkpoint change is already active in this workspace')
    }
    const id = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => this.revoke(id), CHECKPOINT_OPERATION_TIMEOUT_MS)
    timer.unref?.()
    this.operations.set(id, {
      scope: { projectId: scope.projectId, root: { ...scope.root } },
      kind,
      controller,
      timer,
      expiresAt: Date.now() + CHECKPOINT_OPERATION_TIMEOUT_MS,
      busy: false,
      terminal: false,
      files: 0,
      bytes: 0,
      trees: 0,
    })
    return { id, signal: controller.signal, revoke: () => this.revoke(id) }
  }

  async run<T>(
    id: string,
    scope: CheckpointOperationScope,
    effect: (lease: CheckpointOperationLease) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.current(id)
    if (!sameScope(operation.scope, scope))
      throw new Error('Checkpoint authority does not match the workspace')
    if (operation.terminal) throw new Error('Checkpoint ref authority already consumed')
    if (operation.busy) throw new Error('Checkpoint host operation already in flight')
    this.operations.set(id, { ...operation, busy: true })
    try {
      const result = await effect(this.lease(id, operation))
      this.current(id)
      return result
    } catch (error) {
      this.revoke(id)
      throw error
    } finally {
      const latest = this.operations.get(id)
      if (latest?.terminal) this.revoke(id)
      else if (latest) this.operations.set(id, { ...latest, busy: false })
    }
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.operations.keys()) this.revoke(id)
  }

  private lease(id: string, operation: OperationRecord): CheckpointOperationLease {
    return {
      kind: operation.kind,
      signal: operation.controller.signal,
      assertActive: () => {
        this.current(id)
      },
      assertCapture: () => {
        if (this.current(id).kind !== 'capture')
          throw new Error('Checkpoint capture authority required')
      },
      charge: (cost) => this.charge(id, cost),
      finishRef: () => {
        const latest = this.current(id)
        if (latest.kind === 'read' || latest.terminal)
          throw new Error('No checkpoint ref authority')
        this.operations.set(id, { ...latest, terminal: true })
      },
    }
  }

  private charge(
    id: string,
    cost: Parameters<CheckpointOperationLease['charge']>[0],
  ): void {
    const operation = this.current(id)
    const totals = {
      files: addCost(operation.files, cost.files, MAX_FILE_READS),
      bytes: addCost(operation.bytes, cost.bytes, CHECKPOINT_TOTAL_BYTE_LIMIT),
      trees: addCost(operation.trees, cost.trees, MAX_TREES),
    }
    this.operations.set(id, { ...operation, ...totals })
  }

  private current(id: string): OperationRecord {
    const operation = this.operations.get(id)
    if (operation && operation.expiresAt <= Date.now()) this.revoke(id)
    if (!operation || operation.controller.signal.aborted || this.disposed) {
      throw new Error('Checkpoint operation expired or revoked')
    }
    return operation
  }

  private revoke(id: string): void {
    const operation = this.operations.get(id)
    if (!operation) return
    this.operations.delete(id)
    clearTimeout(operation.timer)
    operation.controller.abort()
  }
}

function addCost(previous: number, added: number | undefined, limit: number): number {
  const value = added ?? 0
  if (!Number.isSafeInteger(value) || value < 0 || previous + value > limit) {
    throw new Error('Review checkpoint operation exceeds its workload limit')
  }
  return previous + value
}

function sameScope(a: CheckpointOperationScope, b: CheckpointOperationScope): boolean {
  return a.projectId === b.projectId && hostPathEquals(a.root, b.root)
}

function assertScope(scope: CheckpointOperationScope): void {
  if (
    !scope.projectId ||
    scope.projectId.length > 256 ||
    !scope.root.hostId ||
    !scope.root.path.startsWith('/') ||
    scope.root.path.includes('\0') ||
    scope.root.path.length > 16_384 ||
    hostPath(scope.root.hostId, scope.root.path).path !== scope.root.path
  ) {
    throw new Error('Invalid review checkpoint workspace')
  }
}
