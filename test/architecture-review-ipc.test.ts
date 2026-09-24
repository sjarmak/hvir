import { describe, expect, it, vi } from 'vitest'
import { registerArchitectureReviewIpc } from '../src/main/ipc/features/architecture-review'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import type { IpcRegistrar } from '../src/main/ipc/authority-router'

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
})

function context() {
  return { owner: () => ({ id: 1, generation: 1 }) }
}
