import { describe, expect, it, vi } from 'vitest'

import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { registerSessionsIpc } from '../src/main/ipc/features/sessions'
import type {
  SessionsResolvedExternalAttach,
  SessionsResolvedOpen,
} from '../src/main/sessions/sessions-observation-port'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { rendererDemandOwner } from '../src/main/sessions/sessions-demand-owner'
import { sessionsIpc } from '../src/shared/ipc/sessions'
import {
  SESSIONS_PROJECTION_VERSION,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  SESSIONS_TRANSCRIPT_VERSION,
  type SessionsObservationSnapshot,
  type SessionsTranscriptSnapshot,
} from '../src/shared'

describe('Sessions IPC', () => {
  it('registers one renderer-qualified demand and releases it on rollover', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(17)
    let activeDemand: number | undefined
    const observation = {
      acquire: vi.fn((_owner, demandGeneration: number) => {
        if (activeDemand !== undefined && activeDemand !== demandGeneration) {
          throw new Error('Sessions observation demand is already active')
        }
        activeDemand = demandGeneration
        return snapshot(demandGeneration, 1)
      }),
      snapshot: vi.fn((_owner, demandGeneration: number) =>
        snapshot(demandGeneration, 2),
      ),
      release: vi.fn(() => true),
    }
    const { invoke } = fixture(scopes, observation)
    const context = { owner: () => owner }

    await expect(
      invoke('sessions:observe', { demandGeneration: 4 }, context),
    ).resolves.toMatchObject({ demandGeneration: 4, revision: 1 })
    await expect(
      invoke('sessions:observe', { demandGeneration: 4 }, context),
    ).resolves.toMatchObject({ demandGeneration: 4, revision: 1 })
    expect(observation.acquire).toHaveBeenNthCalledWith(1, rendererDemandOwner(owner), 4)
    expect(observation.acquire).toHaveBeenNthCalledWith(2, rendererDemandOwner(owner), 4)
    await expect(
      invoke('sessions:observe', { demandGeneration: 5 }, context),
    ).rejects.toThrow('already active')
    expect(observation.release).not.toHaveBeenCalledWith(rendererDemandOwner(owner), 5)

    await expect(
      invoke('sessions:snapshot', { demandGeneration: 4 }, context),
    ).resolves.toMatchObject({ revision: 2 })

    const rollover = scopes.rolloverOwner(owner.id)
    await rollover.cleanup
    expect(observation.release).toHaveBeenCalledWith(rendererDemandOwner(owner), 4)
    await scopes.dispose()
  })

  it('makes explicit release idempotent through the renderer resource owner', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(3)
    let activeDemand: number | undefined
    const observation = {
      acquire: vi.fn((_owner, demandGeneration: number) => {
        activeDemand = demandGeneration
        return snapshot(demandGeneration, 1)
      }),
      snapshot: vi.fn((_owner, demandGeneration: number) => {
        if (activeDemand !== demandGeneration) throw new Error('stale demand')
        return snapshot(demandGeneration, 1)
      }),
      release: vi.fn((_owner, demandGeneration: number) => {
        if (activeDemand !== demandGeneration) return false
        activeDemand = undefined
        return true
      }),
    }
    const { invoke } = fixture(scopes, observation)
    const context = { owner: () => owner }

    await invoke('sessions:observe', { demandGeneration: 8 }, context)
    await invoke('sessions:release', { demandGeneration: 8 }, context)
    await invoke('sessions:release', { demandGeneration: 8 }, context)
    await invoke('sessions:observe', { demandGeneration: 9 }, context)
    await invoke('sessions:release', { demandGeneration: 8 }, context)
    await expect(
      invoke('sessions:snapshot', { demandGeneration: 9 }, context),
    ).resolves.toMatchObject({ demandGeneration: 9 })

    expect(observation.release).toHaveBeenCalledTimes(4)
    expect(observation.release).toHaveBeenNthCalledWith(1, rendererDemandOwner(owner), 8)
    expect(observation.release).toHaveBeenNthCalledWith(2, rendererDemandOwner(owner), 8)
    expect(observation.release).toHaveBeenNthCalledWith(4, rendererDemandOwner(owner), 8)
    await scopes.dispose()
    expect(observation.release).toHaveBeenLastCalledWith(rendererDemandOwner(owner), 9)
  })

  it('routes only an exactly resolved Open through the existing workspace owner', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(11)
    const qualifier = sessionsWorkspaceQualifier(3, 0, 0)
    const livePty = {
      handle: asSessionsPtyHandle('instance-1'),
      rendererOwnerId: owner.id,
      rendererGeneration: owner.generation,
    }
    const resolveOpen = vi.fn((): SessionsResolvedOpen => ({
      outcome: 'resolved',
      projectId: 'project-real',
      workspaceId: 'workspace-real',
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceQualifier: qualifier,
      livePty,
    }))
    const observation = {
      acquire: vi.fn(),
      snapshot: vi.fn(),
      release: vi.fn(),
      resolveOpen,
    }
    const switchWorkspace = vi.fn(() =>
      Promise.resolve({ marker: 'production-project-state' }),
    )
    const { invoke } = fixture(scopes, observation, switchWorkspace)
    const request = {
      demandGeneration: 4,
      sourceRevision: 7,
      handle: asSessionsTerminalHandle('terminal-1'),
      projectId: asSessionsProjectHandle('project-opaque'),
      workspaceId: asSessionsWorkspaceHandle('workspace-opaque'),
      workspaceQualifier: qualifier,
      livePty,
    }

    await expect(
      invoke('sessions:open', request, { owner: () => owner }),
    ).resolves.toEqual({
      outcome: 'opened',
      state: { marker: 'production-project-state' },
      handle: 'terminal-1',
      workspaceQualifier: qualifier,
      livePty,
    })
    expect(observation.resolveOpen).toHaveBeenCalledWith(
      rendererDemandOwner(owner),
      request,
    )
    expect(switchWorkspace).toHaveBeenCalledExactlyOnceWith(
      'project-real',
      'workspace-real',
    )

    resolveOpen.mockReturnValueOnce({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })
    await expect(
      invoke('sessions:open', request, { owner: () => owner }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })
    expect(switchWorkspace).toHaveBeenCalledOnce()

    resolveOpen.mockReturnValueOnce({
      outcome: 'resolved',
      projectId: 'project-real',
      workspaceId: 'workspace-real',
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceQualifier: qualifier,
      livePty,
    })
    await expect(
      invoke('sessions:resolve-terminal', request, { owner: () => owner }),
    ).resolves.toEqual({
      outcome: 'resolved',
      handle: 'terminal-1',
      workspaceQualifier: qualifier,
      workspaceRuntimeId: 'workspace-real',
      livePty,
    })
    expect(switchWorkspace).toHaveBeenCalledOnce()
    await scopes.dispose()
  })

  it('routes the exact production Usage demand shape and revokes it with the renderer owner', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(23)
    const observation = {
      acquire: vi.fn(),
      snapshot: vi.fn(),
      release: vi.fn(),
    }
    const { invoke, sessionsUsage } = fixture(scopes, observation)
    const request = {
      demandGeneration: 6,
      projectionDemandGeneration: 4,
      sourceRevision: 9,
      targets: [
        {
          handle: asSessionsTerminalHandle('terminal-usage'),
          livePty: {
            handle: asSessionsPtyHandle('instance-usage'),
            rendererOwnerId: owner.id,
            rendererGeneration: owner.generation,
          },
        },
      ],
    }

    await expect(
      invoke('sessions:usage-observe', request, { owner: () => owner }),
    ).resolves.toMatchObject({ demandGeneration: 6, sampledAt: 100 })
    expect(sessionsUsage.acquire).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      request,
    )
    await expect(
      invoke('sessions:usage-snapshot', { demandGeneration: 6 }, { owner: () => owner }),
    ).resolves.toMatchObject({ demandGeneration: 6, revision: 2 })

    const rollover = scopes.rolloverOwner(owner.id)
    await rollover.cleanup
    expect(sessionsUsage.release).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      6,
    )
    await scopes.dispose()
  })

  it('holds one transcript demand per renderer and drops it with the owner', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(29)
    const observation = { acquire: vi.fn(), snapshot: vi.fn(), release: vi.fn() }
    const { invoke, sessionsTranscripts } = fixture(scopes, observation)
    const context = { owner: () => owner }
    const request = {
      demandGeneration: 2,
      projectionDemandGeneration: 4,
      sourceRevision: 9,
      handle: asSessionsTerminalHandle('sessions-external-0001'),
    }

    await expect(
      invoke('sessions:transcript-observe', request, context),
    ).resolves.toMatchObject({ demandGeneration: 2, revision: 1 })
    expect(sessionsTranscripts.acquire).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      request,
    )
    await expect(
      invoke('sessions:transcript-snapshot', { demandGeneration: 2 }, context),
    ).resolves.toMatchObject({ revision: 2 })
    // Reconnecting is a request, not something the port did on its own.
    await expect(
      invoke('sessions:transcript-resume', { demandGeneration: 2 }, context),
    ).resolves.toMatchObject({ revision: 3 })
    expect(sessionsTranscripts.resume).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      2,
    )

    const rollover = scopes.rolloverOwner(owner.id)
    await rollover.cleanup
    expect(sessionsTranscripts.release).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      2,
    )
    await scopes.dispose()
  })

  it('carries an answer and a message, and nothing about the interaction itself', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(37)
    const observation = { acquire: vi.fn(), snapshot: vi.fn(), release: vi.fn() }
    const { invoke, sessionsTranscripts } = fixture(scopes, observation)
    const context = { owner: () => owner }
    const handle = asSessionsTerminalHandle('sessions-external-0001')
    const answer = {
      demandGeneration: 2,
      handle,
      pendingRevision: 3,
      // A position, not an option word and not gc's request identifier: the
      // renderer never received either (ADR-046).
      optionOrdinal: 1,
    }
    const message = { demandGeneration: 2, handle, message: 'hold the release' }

    await expect(invoke('sessions:respond', answer, context)).resolves.toEqual({
      outcome: 'accepted',
    })
    await expect(invoke('sessions:submit', message, context)).resolves.toEqual({
      outcome: 'accepted',
    })
    expect(sessionsTranscripts.respond).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      answer,
    )
    expect(sessionsTranscripts.submit).toHaveBeenCalledExactlyOnceWith(
      rendererDemandOwner(owner),
      message,
    )

    const stale = scopes.rolloverOwner(owner.id)
    await stale.cleanup
    // A revoked renderer cannot answer for the one that replaced it.
    await expect(invoke('sessions:respond', answer, context)).rejects.toThrow()
    await scopes.dispose()
  })

  it('carries no mutation of a session other than an answer and a message', () => {
    // ADR-048: reset, handoff, and everything else in a session's lifecycle
    // stay with the view that owns the city. This is the whole surface.
    expect(Object.keys(sessionsIpc.invoke).sort()).toEqual([
      'sessions:attach-external',
      'sessions:observe',
      'sessions:open',
      'sessions:release',
      'sessions:resolve-terminal',
      'sessions:respond',
      'sessions:snapshot',
      'sessions:submit',
      'sessions:transcript-observe',
      'sessions:transcript-release',
      'sessions:transcript-resume',
      'sessions:transcript-snapshot',
      'sessions:usage-observe',
      'sessions:usage-release',
      'sessions:usage-snapshot',
    ])
    expect(Object.keys(sessionsIpc.send)).toEqual([])
  })

  it('answers an external Attach with a command and a ticket, never the identifier', async () => {
    const scopes = new RendererResourceScopes()
    const owner = scopes.activateOwner(31)
    const qualifier = sessionsWorkspaceQualifier(3, 0, 0)
    const resolveExternalAttach = vi.fn((): SessionsResolvedExternalAttach => ({
      outcome: 'resolved',
      projectId: 'project-real',
      workspaceId: 'workspace-real',
      handle: asSessionsTerminalHandle('sessions-external-0001'),
      target: {
        sourceId: 'gas-city',
        hostId: 'local' as never,
        key: 'gc-mem-worker-1',
        attachTarget: 'mem-worker-1',
      },
      attachTarget: 'mem-worker-1',
    }))
    const observation = {
      acquire: vi.fn(),
      snapshot: vi.fn(),
      release: vi.fn(),
      resolveExternalAttach,
    }
    const switchWorkspace = vi.fn(() => Promise.resolve({ marker: 'switched' }))
    const { invoke, sessionsAttachTickets } = fixture(
      scopes,
      observation,
      switchWorkspace,
    )
    const request = {
      demandGeneration: 4,
      sourceRevision: 7,
      handle: asSessionsTerminalHandle('sessions-external-0001'),
      projectId: asSessionsProjectHandle('project-opaque'),
      workspaceId: asSessionsWorkspaceHandle('workspace-opaque'),
      workspaceQualifier: qualifier,
    }

    const attached = await invoke('sessions:attach-external', request, {
      owner: () => owner,
    })

    expect(attached).toEqual({
      outcome: 'attached',
      state: { marker: 'switched' },
      handle: 'sessions-external-0001',
      target: {
        command: "gc session attach 'mem-worker-1'",
        key: 'gc:mem-worker-1',
        ticket: 'a'.repeat(32),
      },
    })
    // The command carries the source's published alias; the session identifier
    // stays behind the ticket (ADR-046).
    expect(JSON.stringify(attached)).not.toContain('gc-mem-worker-1')
    expect(sessionsAttachTickets.mint).toHaveBeenCalledExactlyOnceWith(owner, {
      sourceId: 'gas-city',
      key: 'gc-mem-worker-1',
    })
    expect(switchWorkspace).toHaveBeenCalledExactlyOnceWith(
      'project-real',
      'workspace-real',
    )

    resolveExternalAttach.mockReturnValueOnce({
      outcome: 'unavailable',
      reason: 'not-projected',
    })
    await expect(
      invoke('sessions:attach-external', request, { owner: () => owner }),
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'not-projected' })
    expect(switchWorkspace).toHaveBeenCalledOnce()
    expect(sessionsAttachTickets.mint).toHaveBeenCalledOnce()
    await scopes.dispose()
  })
})

function fixture(
  rendererResources: RendererResourceScopes,
  sessionsObservation: {
    acquire: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    resolveOpen?: ReturnType<typeof vi.fn>
    resolveExternalAttach?: ReturnType<typeof vi.fn>
  },
  switchWorkspace = vi.fn(),
) {
  const handlers = new Map<string, (request: never, context: never) => unknown>()
  const ipc = {
    handle: (channel: string, handler: (request: never, context: never) => unknown) => {
      handlers.set(channel, handler)
    },
  } as unknown as IpcRegistrar
  const sessionsUsage = {
    acquire: vi.fn((_owner, request: { demandGeneration: number }) => ({
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration: request.demandGeneration,
      revision: 1,
      sampledAt: 100,
      rows: [],
    })),
    snapshot: vi.fn((_owner, demandGeneration: number) => ({
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration,
      revision: 2,
      sampledAt: 200,
      rows: [],
    })),
    release: vi.fn(() => true),
  }
  const sessionsTranscripts = {
    acquire: vi.fn((_owner, request: { demandGeneration: number }) =>
      transcriptSnapshot(request.demandGeneration, 1),
    ),
    snapshot: vi.fn((_owner, demandGeneration: number) =>
      transcriptSnapshot(demandGeneration, 2),
    ),
    resume: vi.fn((_owner, demandGeneration: number) =>
      transcriptSnapshot(demandGeneration, 3),
    ),
    respond: vi.fn(() => Promise.resolve({ outcome: 'accepted' })),
    submit: vi.fn(() => Promise.resolve({ outcome: 'accepted' })),
    release: vi.fn(() => true),
  }
  const sessionsAttachTickets = { mint: vi.fn(() => 'a'.repeat(32)) }
  registerSessionsIpc(ipc, {
    rendererResources,
    sessionsObservation: {
      ...sessionsObservation,
      resolveOpen:
        sessionsObservation.resolveOpen ??
        vi.fn(() => ({ outcome: 'unavailable', reason: 'stale-projection' })),
      resolveExternalAttach:
        sessionsObservation.resolveExternalAttach ??
        vi.fn(() => ({ outcome: 'unavailable', reason: 'stale-projection' })),
    },
    sessionsUsage,
    sessionsTranscripts,
    sessionsAttachTickets,
    switchWorkspace,
  } as never)
  return {
    sessionsUsage,
    sessionsTranscripts,
    sessionsAttachTickets,
    invoke: (channel: string, request: unknown, context: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Missing handler ${channel}`)
      return Promise.resolve().then(() => handler(request as never, context as never))
    },
  }
}

function transcriptSnapshot(
  demandGeneration: number,
  revision: number,
): SessionsTranscriptSnapshot {
  return {
    version: SESSIONS_TRANSCRIPT_VERSION,
    demandGeneration,
    revision,
    handle: asSessionsTerminalHandle('sessions-external-0001'),
    status: 'ready',
    stream: 'live',
    turns: [],
    older: false,
    dropped: 0,
  }
}

function snapshot(
  demandGeneration: number,
  revision: number,
): SessionsObservationSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision,
    workspaces: [],
    providers: [],
    sessions: [],
  }
}
