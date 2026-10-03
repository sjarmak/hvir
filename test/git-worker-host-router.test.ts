import { describe, expect, it, vi } from 'vitest'

import { GIT_FETCH_ARGS } from '../src/main/git/git-engine'
import { GitMutationAuthorization } from '../src/main/git/mutation-authorization'
import {
  GitWorkerHostRouter,
  type GitWorkerAuthorityPort,
} from '../src/main/git/worker-host-router'
import { dispatchWorkerHostCall } from '../src/main/git/worker-host-broker'
import { ReviewCheckpointHost } from '../src/main/git/review-checkpoint-host'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, localPath, type WorkerHostCall } from '../src/shared'

const root = localPath('/repo')
const host = {
  hostId: root.hostId,
  connectionState: 'connected',
  watchTier: 'native',
} as unknown as ProjectHost
const authority = { projectId: 'project-1', host, root }
const fetchCall: WorkerHostCall = {
  kind: 'host-call',
  callId: 1,
  hostId: root.hostId,
  operation: 'exec',
  command: 'git',
  args: ['-C', root.path, ...GIT_FETCH_ARGS],
}

function fixture() {
  const authorityForPath = vi.fn<GitWorkerAuthorityPort['authorityForPath']>(
    () => authority,
  )
  const authorizations = new GitMutationAuthorization()
  const dispatch = vi.fn<typeof dispatchWorkerHostCall>(() =>
    Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' }),
  )
  const router = new GitWorkerHostRouter({
    authority: { authorityForPath },
    authorizations,
    dispatch,
  })
  return { router, authorizations, authorityForPath, dispatch }
}

describe('GitWorkerHostRouter', () => {
  it('resolves authority and passes one exact permission to the broker', async () => {
    const { router, authorizations, authorityForPath, dispatch } = fixture()
    authorizations.grant({ kind: 'fetch', projectId: 'project-1', root })

    await router.route(fetchCall)

    expect(authorityForPath).toHaveBeenCalledWith('local', '/repo')
    expect(dispatch).toHaveBeenCalledWith(fetchCall, authority, { allowFetch: true })
  })

  it('does not dispatch an unauthorized synthesized mutation', async () => {
    const { router, dispatch } = fixture()

    await expect(router.route(fetchCall)).rejects.toThrow('no exact grant')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes read calls without granting mutation authority', async () => {
    const { router, dispatch } = fixture()
    const read: WorkerHostCall = {
      kind: 'host-call',
      callId: 2,
      hostId: root.hostId,
      operation: 'readTextFile',
      path: localPath('/repo/file.txt'),
    }

    await router.route(read)

    expect(dispatch).toHaveBeenCalledWith(read, authority, {})
  })

  it('routes checkpoints only through their dedicated operation owner', async () => {
    const checkpoints = new ReviewCheckpointHost()
    const dispatch = vi.spyOn(checkpoints, 'dispatch').mockResolvedValue(null)
    const ordinary = vi.fn<typeof dispatchWorkerHostCall>()
    const authorizations = new GitMutationAuthorization()
    const router = new GitWorkerHostRouter({
      authority: { authorityForPath: () => authority },
      authorizations,
      checkpoints,
      dispatch: ordinary,
    })
    const call: WorkerHostCall = {
      kind: 'host-call',
      callId: 5,
      hostId: root.hostId,
      operation: 'reviewCheckpoint',
      path: root,
      operationId: 'capture-grant',
      request: { action: 'inspect' },
    }
    await expect(router.route(call)).resolves.toBeNull()
    expect(dispatch).toHaveBeenCalledWith('capture-grant', authority, call.request)
    expect(ordinary).not.toHaveBeenCalled()
    for (const path of [
      localPath('/repo/child'),
      hostPath(asHostId('ssh:other'), '/repo'),
    ]) {
      await expect(router.route({ ...call, path })).rejects.toThrow('authority')
    }
    expect(dispatch).toHaveBeenCalledTimes(1)
    checkpoints.dispose()
    authorizations.dispose()
  })

  it('rejects checkpoint calls when their dedicated owner is unavailable', async () => {
    const { router, dispatch } = fixture()
    await expect(
      router.route({
        kind: 'host-call',
        callId: 6,
        hostId: root.hostId,
        operation: 'reviewCheckpoint',
        path: root,
        operationId: 'missing',
        request: { action: 'inspect' },
      }),
    ).rejects.toThrow('authority')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
