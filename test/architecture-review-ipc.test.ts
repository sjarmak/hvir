import { describe, expect, it, vi } from 'vitest'
import { registerArchitectureReviewIpc } from '../src/main/ipc/features/architecture-review'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { ArchitectureScopeRefusalError } from '../src/main/architecture-review/scope-cap'
import type { ArchitectureScopeRefusal } from '../src/shared/architecture-scope'
import type { ArchitectureReviewCoordinator } from '../src/main/architecture-review/coordinator'

type TestContext = {
  readonly owner: () => { readonly id: number; readonly generation: number }
}
type TestHandler = (request: unknown, context: TestContext) => unknown

describe('architecture review IPC authority', () => {
  it('rejects a request for another host before capture', async () => {
    const root = localPath('/repo')
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    const scan = vi.fn()
    const handlers = new Map<string, TestHandler>()
    const deps = {
      getProject: () => ({ root, host }),
      architectureReview: { scan, evidence: vi.fn(), close: vi.fn() },
    }
    registerArchitectureReviewIpc(
      {
        handle: (channel: string, handler: TestHandler) => handlers.set(channel, handler),
        authority: { projectPath: vi.fn() },
      } as unknown as IpcRegistrar,
      deps as unknown as Parameters<typeof registerArchitectureReviewIpc>[1],
    )
    await expect(
      handlers.get('architecture-review:scan')?.(
        { root: hostPath(asHostId('ssh'), '/repo'), baseline: 'HEAD', reviewId: 'r1' },
        context(),
      ),
    ).rejects.toThrow(/active workspace|authority/)
    expect(scan).not.toHaveBeenCalled()
  })

  it('rejects a workspace replacement that happens while capture awaits', async () => {
    const root = localPath('/repo')
    const replacement = localPath('/other')
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    const replacementHost = {
      hostId: replacement.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    let active = { root, host }
    let release!: () => void
    const scan = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve(undefined)
        }),
    )
    const close = vi.fn()
    const handlers = new Map<string, TestHandler>()
    registerArchitectureReviewIpc(
      {
        handle: (channel: string, handler: TestHandler) => handlers.set(channel, handler),
        authority: { projectPath: vi.fn() },
      } as unknown as IpcRegistrar,
      {
        getProject: () => active,
        architectureReview: { scan, evidence: vi.fn(), close },
      } as unknown as Parameters<typeof registerArchitectureReviewIpc>[1],
    )
    const pending = handlers.get('architecture-review:scan')?.(
      { root, baseline: 'HEAD', reviewId: 'r2' },
      context(),
    )
    await Promise.resolve()
    active = { root: replacement, host: replacementHost }
    release()
    await expect(pending).rejects.toThrow(/changed|active workspace/)
    expect(close).toHaveBeenCalled()
  })

  it('lists the commit strip only for the active workspace, through its host', async () => {
    const root = localPath('/repo')
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    const range = { base: {}, commits: [], truncated: false }
    const commits = vi.fn(() => Promise.resolve(range))
    const projectPath = vi.fn()
    const handlers = new Map<string, TestHandler>()
    registerArchitectureReviewIpc(
      {
        handle: (channel: string, handler: TestHandler) => handlers.set(channel, handler),
        authority: { projectPath },
      } as unknown as IpcRegistrar,
      {
        getProject: () => ({ root, host }),
        architectureReview: { commits },
      } as unknown as Parameters<typeof registerArchitectureReviewIpc>[1],
    )
    const handler = handlers.get('architecture-review:commits')!
    await expect(
      handler({ root: hostPath(asHostId('ssh'), '/repo') }, context()),
    ).rejects.toThrow(/active workspace/)
    expect(commits).not.toHaveBeenCalled()
    await expect(handler({ root, from: 'v1' }, context())).resolves.toBe(range)
    expect(projectPath).toHaveBeenCalledWith(root, root, host)
    expect(commits).toHaveBeenCalledWith({ id: 1, generation: 1 }, host, {
      root,
      from: 'v1',
    })
  })

  it('publishes settled live changes only to the renderer that started following', async () => {
    const root = localPath('/repo')
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    const follow = vi.fn<ArchitectureReviewCoordinator['follow']>(
      (_owner, _host, _request, publish) => publish(),
    )
    const send = vi.fn()
    const handlers = new Map<string, TestHandler>()
    registerArchitectureReviewIpc(
      {
        handle: (channel: string, handler: TestHandler) => handlers.set(channel, handler),
        authority: { projectPath: vi.fn() },
      } as unknown as IpcRegistrar,
      {
        getProject: () => ({ root, host }),
        architectureReview: { follow },
      } as unknown as Parameters<typeof registerArchitectureReviewIpc>[1],
    )
    const request = { root, reviewId: 'r-live' }
    await handlers.get('architecture-review:follow')?.(request, {
      owner: () => ({ id: 1, generation: 1 }),
      sender: { isDestroyed: () => false, send },
    } as unknown as TestContext)
    expect(follow).toHaveBeenCalledWith(
      { id: 1, generation: 1 },
      host,
      request,
      expect.any(Function),
    )
    expect(send).toHaveBeenCalledWith('architecture-review:changed', request)
  })

  it('returns an over-cap scan as a refusal, not as a failure', async () => {
    const root = localPath('/repo')
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    const refusal = { message: 'Architecture scan refused: ...', files: 4_001 }
    const handlers = new Map<string, TestHandler>()
    registerArchitectureReviewIpc(
      {
        handle: (channel: string, handler: TestHandler) => handlers.set(channel, handler),
        authority: { projectPath: vi.fn() },
      } as unknown as IpcRegistrar,
      {
        getProject: () => ({ root, host }),
        architectureReview: {
          scan: () =>
            Promise.reject(
              new ArchitectureScopeRefusalError(
                refusal as unknown as ArchitectureScopeRefusal,
              ),
            ),
          close: vi.fn(),
        },
      } as unknown as Parameters<typeof registerArchitectureReviewIpc>[1],
    )
    await expect(
      handlers.get('architecture-review:scan')?.({ root, reviewId: 'r3' }, context()),
    ).resolves.toEqual({ refused: refusal })
  })

  it('records the scope only in the active workspace layout file it authorized', async () => {
    const root = localPath('/repo')
    const host = {
      hostId: root.hostId,
      connectionState: 'connected',
    } as unknown as ProjectHost
    const canonical = localPath('/repo/.hvir/architecture.json')
    const projectPath = vi.fn(() => Promise.resolve(canonical))
    const recordScope = vi.fn(() => Promise.resolve({ scope: ['src'], written: true }))
    const handlers = new Map<string, TestHandler>()
    registerArchitectureReviewIpc(
      {
        handle: (channel: string, handler: TestHandler) => handlers.set(channel, handler),
        authority: { projectPath },
      } as unknown as IpcRegistrar,
      {
        getProject: () => ({ root, host }),
        architectureReview: { recordScope },
      } as unknown as Parameters<typeof registerArchitectureReviewIpc>[1],
    )
    const handler = handlers.get('architecture-review:scope')!
    await expect(
      handler({ root: hostPath(asHostId('ssh'), '/repo'), scope: ['src'] }, context()),
    ).rejects.toThrow(/active workspace/)
    expect(recordScope).not.toHaveBeenCalled()
    await expect(handler({ root, scope: ['src'] }, context())).resolves.toEqual({
      scope: ['src'],
      written: true,
    })
    expect(projectPath).toHaveBeenCalledWith(
      localPath('/repo/.hvir/architecture.json'),
      root,
      host,
      { allowMissingLeaf: true, returnCanonical: true },
    )
    expect(recordScope).toHaveBeenCalledWith({ id: 1, generation: 1 }, host, canonical, {
      root,
      scope: ['src'],
    })
  })
})

function context() {
  return { owner: () => ({ id: 1, generation: 1 }) }
}
