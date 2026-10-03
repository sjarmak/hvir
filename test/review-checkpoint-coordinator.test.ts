import { describe, expect, it, vi } from 'vitest'

import { ReviewCheckpointCoordinator } from '../src/main/git/review-checkpoint-coordinator'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { asHostId, hostPath } from '../src/shared'
import type { ReviewCheckpointResult } from '../src/shared/review-checkpoint'

const root = hostPath(asHostId('local'), '/repo')
const otherRoot = hostPath(asHostId('local'), '/other')

describe('ReviewCheckpointCoordinator', () => {
  it('fails closed when the requested root is not active', async () => {
    const worker = { request: vi.fn() }
    const checkpoints = fakeCheckpoints()
    const coordinator = makeCoordinator(root, worker, checkpoints)
    await expect(
      coordinator.request(owner(), 'one', { action: 'status', root: otherRoot }),
    ).rejects.toThrow('no longer active')
    expect(worker.request).not.toHaveBeenCalled()
    expect(checkpoints.begin).not.toHaveBeenCalled()
  })

  it('revokes the grant and drops the resource on cancellation', async () => {
    const pending = deferred<ReviewCheckpointResult>()
    const worker = { request: vi.fn(() => pending.promise) }
    const checkpoints = fakeCheckpoints()
    const resources = new RendererResourceScopes()
    const activeOwner = resources.activateOwner(1)
    const coordinator = makeCoordinator(root, worker, checkpoints, resources)
    const result = coordinator.request(activeOwner, 'one', { action: 'capture', root })
    await Promise.resolve()
    expect(worker.request).toHaveBeenCalledWith('git:review-checkpoint', {
      action: 'capture',
      root,
      operationId: checkpoints.grant.id,
    })
    await coordinator.cancel(activeOwner, 'one')
    expect(checkpoints.grant.revoke).toHaveBeenCalled()
    pending.resolve({ root, oid: null, changes: [] })
    await expect(result).rejects.toThrow('canceled')
    await expect(coordinator.cancel(activeOwner, 'one')).resolves.toBeUndefined()
  })

  it('accepts a successful worker completion after the broker closes its grant', async () => {
    const checkpoints = fakeCheckpoints()
    const worker = {
      request: vi.fn(() => {
        checkpoints.grant.revoke()
        return Promise.resolve({ root, oid: null, changes: [] })
      }),
    }
    const resources = new RendererResourceScopes()
    const activeOwner = resources.activateOwner(1)
    const coordinator = makeCoordinator(root, worker, checkpoints, resources)
    await expect(
      coordinator.request(activeOwner, 'one', { action: 'status', root }),
    ).resolves.toEqual({ root, oid: null, changes: [] })
    expect(checkpoints.grant.revoke).toHaveBeenCalled()
  })

  it('rejects a completion after the active workspace changes', async () => {
    const pending = deferred<ReviewCheckpointResult>()
    const worker = { request: vi.fn(() => pending.promise) }
    const checkpoints = fakeCheckpoints()
    const active = { root }
    const resources = new RendererResourceScopes()
    const activeOwner = resources.activateOwner(1)
    const coordinator = makeCoordinator(active, worker, checkpoints, resources)
    const result = coordinator.request(activeOwner, 'one', { action: 'status', root })
    active.root = otherRoot
    pending.resolve({ root, oid: null, changes: [] })
    await expect(result).rejects.toThrow('no longer active')
    expect(checkpoints.grant.revoke).toHaveBeenCalled()
  })

  it('rejects a completion after project, workspace, or host identity changes', async () => {
    const pending = deferred<ReviewCheckpointResult>()
    const worker = { request: vi.fn(() => pending.promise) }
    const checkpoints = fakeCheckpoints()
    const active = {
      root,
      projectId: 'project',
      workspaceId: 'workspace',
      host: { hostId: 'local' },
    }
    const resources = new RendererResourceScopes()
    const activeOwner = resources.activateOwner(1)
    const coordinator = makeCoordinator(active, worker, checkpoints, resources)
    const result = coordinator.request(activeOwner, 'one', { action: 'status', root })
    active.projectId = 'other-project'
    pending.resolve({ root, oid: null, changes: [] })
    await expect(result).rejects.toThrow('no longer active')

    const second = fakeCheckpoints()
    const secondActive = {
      root,
      projectId: 'project',
      workspaceId: 'workspace',
      host: { hostId: 'local' },
    }
    const secondPending = deferred<ReviewCheckpointResult>()
    worker.request.mockImplementationOnce(() => secondPending.promise)
    const secondCoordinator = makeCoordinator(secondActive, worker, second, resources)
    const secondResult = secondCoordinator.request(activeOwner, 'two', {
      action: 'status',
      root,
    })
    secondActive.host = { hostId: 'remote' }
    secondPending.resolve({ root, oid: null, changes: [] })
    await expect(secondResult).rejects.toThrow('no longer active')
  })

  it('revokes a grant when resource registration fails', async () => {
    const worker = { request: vi.fn() }
    const checkpoints = fakeCheckpoints()
    const resources = new RendererResourceScopes()
    const coordinator = makeCoordinator(root, worker, checkpoints, resources)
    await expect(
      coordinator.request(owner(), 'one', { action: 'status', root }),
    ).rejects.toThrow('revoked')
    expect(checkpoints.grant.revoke).toHaveBeenCalled()
    expect(worker.request).not.toHaveBeenCalled()
  })

  it('revokes active grants on disposal', async () => {
    const pending = deferred<ReviewCheckpointResult>()
    const worker = { request: vi.fn(() => pending.promise) }
    const checkpoints = fakeCheckpoints()
    const resources = new RendererResourceScopes()
    const activeOwner = resources.activateOwner(1)
    const coordinator = makeCoordinator(root, worker, checkpoints, resources)
    const result = coordinator.request(activeOwner, 'one', { action: 'status', root })
    await Promise.resolve()
    coordinator.dispose()
    pending.resolve({ root, oid: null, changes: [] })
    await expect(result).rejects.toThrow('canceled')
    expect(checkpoints.grant.revoke).toHaveBeenCalled()
  })
})

function owner() {
  return { id: 1, generation: 1 }
}

function makeCoordinator(
  activeRoot:
    | ({ root: typeof root } & Partial<{
        projectId: string
        workspaceId: string
        host: object
      }>)
    | typeof root,
  worker: { request: ReturnType<typeof vi.fn> },
  checkpoints: ReturnType<typeof fakeCheckpoints>,
  resources = new RendererResourceScopes(),
) {
  const active =
    typeof activeRoot === 'object' && 'root' in activeRoot
      ? activeRoot
      : { root: activeRoot }
  const defaultHost = { hostId: 'local', connectionState: 'connected' }
  const registry = {
    get active() {
      return {
        projectId: active.projectId ?? 'project',
        workspaceId: active.workspaceId ?? 'workspace',
        root: active.root,
        host: active.host ?? defaultHost,
      }
    },
  }
  return new ReviewCheckpointCoordinator({
    registry: registry as never,
    worker: worker as never,
    checkpoints: checkpoints as never,
    resources,
  })
}

function fakeCheckpoints() {
  const controller = new AbortController()
  const grant = {
    revoke: vi.fn(() => controller.abort()),
    id: 'grant',
    signal: controller.signal,
  }
  return { begin: vi.fn(() => grant), grant }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
