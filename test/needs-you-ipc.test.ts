import { describe, expect, it, vi } from 'vitest'

import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { registerNeedsYouIpc } from '../src/main/ipc/features/needs-you'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { rendererDemandOwner } from '../src/main/sessions/sessions-demand-owner'
import type { NeedsYouSnapshot } from '../src/shared'

describe('Needs you IPC', () => {
  it('keeps a late failed observation from disposing a newer generation resource', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(21)
    let rejectFirst!: (reason: Error) => void
    let active: number | undefined
    const needsYou = {
      acquire: vi.fn((_owner, request: { demandGeneration: number }) => {
        active = request.demandGeneration
        if (request.demandGeneration === 1) {
          return new Promise<NeedsYouSnapshot>((_, reject) => {
            rejectFirst = reject
          })
        }
        return Promise.resolve(snapshot(request.demandGeneration))
      }),
      snapshot: vi.fn((_owner, request: { demandGeneration: number }) => snapshot(request.demandGeneration)),
      release: vi.fn((_owner, generation: number) => {
        if (active !== generation) return false
        active = undefined
        return true
      }),
    }
    const invoke = fixture(scopes, needsYou)
    const context = { owner: () => owner }
    const first = invoke('needs-you:observe', { demandGeneration: 1 }, context)
    await invoke('needs-you:release', { demandGeneration: 1 }, context)
    await expect(invoke('needs-you:observe', { demandGeneration: 2 }, context)).resolves.toMatchObject({
      demandGeneration: 2,
    })
    rejectFirst(new Error('stale read'))
    await expect(first).rejects.toThrow('stale read')
    await expect(invoke('needs-you:snapshot', { demandGeneration: 2 }, context)).resolves.toMatchObject({
      demandGeneration: 2,
    })
    await invoke('needs-you:release', { demandGeneration: 2 }, context)
    expect(needsYou.release).toHaveBeenCalledWith(rendererDemandOwner(owner), 2)
    expect(needsYou.release).toHaveBeenCalledWith(rendererDemandOwner(owner), 1)
    await scopes.dispose()
  })

  it('rejects malformed demand generations before reaching the service', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(22)
    const needsYou = {
      acquire: vi.fn(),
      snapshot: vi.fn(),
      release: vi.fn(),
    }
    const invoke = fixture(scopes, needsYou)
    await expect(invoke('needs-you:observe', { demandGeneration: 0 }, { owner: () => owner })).rejects.toThrow(
      'Invalid Needs you demand generation',
    )
    expect(needsYou.acquire).not.toHaveBeenCalled()
    await scopes.dispose()
  })

  it('does not let a mismatched duplicate observe dispose the active resource', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(23)
    const needsYou = {
      acquire: vi.fn((_owner, request: { demandGeneration: number }) => {
        if (request.demandGeneration !== 1) throw new Error('Needs you observation is already active')
        return Promise.resolve(snapshot(1))
      }),
      snapshot: vi.fn((_owner, request: { demandGeneration: number }) => snapshot(request.demandGeneration)),
      release: vi.fn((_owner, generation: number) => generation === 1),
    }
    const invoke = fixture(scopes, needsYou)
    const context = { owner: () => owner }
    await invoke('needs-you:observe', { demandGeneration: 1 }, context)
    await expect(invoke('needs-you:observe', { demandGeneration: 2 }, context)).rejects.toThrow(
      'Needs you observation is already active',
    )
    await expect(invoke('needs-you:snapshot', { demandGeneration: 1 }, context)).resolves.toMatchObject({
      demandGeneration: 1,
    })
    await scopes.dispose()
  })

  it('allows an initial observe failure to retry with the same demand generation', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(24)
    let attempts = 0
    const needsYou = {
      acquire: vi.fn((_owner, request: { demandGeneration: number }) => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('temporary read failure'))
          : Promise.resolve(snapshot(request.demandGeneration))
      }),
      snapshot: vi.fn(),
      release: vi.fn(() => true),
    }
    const invoke = fixture(scopes, needsYou)
    const context = { owner: () => owner }
    await expect(invoke('needs-you:observe', { demandGeneration: 7 }, context)).rejects.toThrow(
      'temporary read failure',
    )
    await expect(invoke('needs-you:observe', { demandGeneration: 7 }, context)).resolves.toMatchObject({
      demandGeneration: 7,
    })
    expect(attempts).toBe(2)
    await scopes.dispose()
  })
})

function fixture(
  rendererResources: RendererResourceScopes,
  needsYou: {
    acquire: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  },
) {
  const handlers = new Map<string, (request: never, context: never) => unknown>()
  const ipc = {
    handle: (channel: string, handler: (request: never, context: never) => unknown) => {
      handlers.set(channel, handler)
    },
  } as unknown as IpcRegistrar
  registerNeedsYouIpc(ipc, { rendererResources, needsYou } as never)
  return (channel: string, request: unknown, context: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler ${channel}`)
    return Promise.resolve().then(() => handler(request as never, context as never))
  }
}

function snapshot(demandGeneration: number): NeedsYouSnapshot {
  return {
    version: 1,
    demandGeneration,
    revision: 1,
    observedAt: 1,
    sources: [],
  }
}
