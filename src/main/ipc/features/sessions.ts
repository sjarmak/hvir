import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { asSessionsWorkspaceRuntimeId, gasCityAttachCommand } from '../../../shared'

type SessionsIpcDeps = Pick<
  IpcDeps,
  | 'rendererResources'
  | 'sessionsObservation'
  | 'sessionsUsage'
  | 'sessionsTranscripts'
  | 'sessionsAttachTickets'
  | 'switchWorkspace'
>

export function registerSessionsIpc(ipc: IpcRegistrar, deps: SessionsIpcDeps): void {
  ipc.handle('sessions:observe', (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const snapshot = deps.sessionsObservation.acquire(owner, request.demandGeneration)
    try {
      deps.rendererResources.register(
        owner,
        { lifetime: 'renderer', type: 'sessions-observation' },
        () => {
          deps.sessionsObservation.release(owner, request.demandGeneration)
        },
        { duplicate: 'reuse' },
      )
      return snapshot
    } catch (error) {
      deps.sessionsObservation.release(owner, request.demandGeneration)
      throw error
    }
  })

  ipc.handle('sessions:snapshot', (request, context) =>
    deps.sessionsObservation.snapshot(context.owner(), request.demandGeneration),
  )

  ipc.handle('sessions:release', async (request, context) => {
    const owner = context.owner()
    // Qualify the release at the observation owner before touching the renderer
    // resource. A duplicate from an older demand must not revoke a newer lease.
    if (!deps.sessionsObservation.release(owner, request.demandGeneration)) return
    await deps.rendererResources.disposeResource(owner, 'sessions-observation')
  })

  ipc.handle('sessions:usage-observe', (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const snapshot = deps.sessionsUsage.acquire(owner, request)
    try {
      deps.rendererResources.register(
        owner,
        { lifetime: 'renderer', type: 'sessions-usage-observation' },
        () => {
          deps.sessionsUsage.release(owner, request.demandGeneration)
        },
        { duplicate: 'reuse' },
      )
      return snapshot
    } catch (error) {
      deps.sessionsUsage.release(owner, request.demandGeneration)
      throw error
    }
  })

  ipc.handle('sessions:usage-snapshot', (request, context) =>
    deps.sessionsUsage.snapshot(context.owner(), request.demandGeneration),
  )

  ipc.handle('sessions:usage-release', async (request, context) => {
    const owner = context.owner()
    if (!deps.sessionsUsage.release(owner, request.demandGeneration)) return
    await deps.rendererResources.disposeResource(owner, 'sessions-usage-observation')
  })

  ipc.handle('sessions:open', async (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const target = deps.sessionsObservation.resolveOpen(owner, request)
    if (target.outcome === 'unavailable') return target
    const state = await deps.switchWorkspace(target.projectId, target.workspaceId)
    deps.rendererResources.assertCurrent(owner)
    return {
      outcome: 'opened' as const,
      state,
      handle: target.handle,
      workspaceQualifier: target.workspaceQualifier,
      livePty: target.livePty,
    }
  })

  ipc.handle('sessions:resolve-terminal', (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const target = deps.sessionsObservation.resolveOpen(owner, request)
    if (target.outcome === 'unavailable') return target
    return {
      outcome: 'resolved' as const,
      handle: target.handle,
      workspaceQualifier: target.workspaceQualifier,
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId(target.workspaceId),
      livePty: target.livePty,
    }
  })

  ipc.handle('sessions:transcript-observe', (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const snapshot = deps.sessionsTranscripts.acquire(owner, request)
    try {
      deps.rendererResources.register(
        owner,
        { lifetime: 'renderer', type: 'sessions-transcript-observation' },
        () => {
          deps.sessionsTranscripts.release(owner, request.demandGeneration)
        },
        { duplicate: 'reuse' },
      )
      return snapshot
    } catch (error) {
      deps.sessionsTranscripts.release(owner, request.demandGeneration)
      throw error
    }
  })

  ipc.handle('sessions:transcript-snapshot', (request, context) =>
    deps.sessionsTranscripts.snapshot(context.owner(), request.demandGeneration),
  )

  ipc.handle('sessions:transcript-resume', (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    return deps.sessionsTranscripts.resume(owner, request.demandGeneration)
  })

  ipc.handle('sessions:transcript-release', async (request, context) => {
    const owner = context.owner()
    if (!deps.sessionsTranscripts.release(owner, request.demandGeneration)) return
    await deps.rendererResources.disposeResource(owner, 'sessions-transcript-observation')
  })

  ipc.handle('sessions:attach-external', async (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const target = deps.sessionsObservation.resolveExternalAttach(owner, request)
    if (target.outcome === 'unavailable') return target
    // The command is the source's own published alias, and the ticket is what
    // the launch will redeem: the session identifier stays on this side.
    const command = gasCityAttachCommand(target.attachTarget)
    const ticket = deps.sessionsAttachTickets.mint(owner, {
      sourceId: target.target.sourceId,
      key: target.target.key,
    })
    const state = await deps.switchWorkspace(target.projectId, target.workspaceId)
    deps.rendererResources.assertCurrent(owner)
    return {
      outcome: 'attached' as const,
      state,
      handle: target.handle,
      target: { ...command, ticket },
    }
  })
}
