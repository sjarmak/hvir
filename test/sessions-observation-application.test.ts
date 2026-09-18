import { describe, expect, it, vi, type Mock } from 'vitest'

import { installApplicationSessionsObservation } from '../src/main/sessions/sessions-observation-application'
import {
  rendererDemandOwner,
  type SessionsCompanionDemandOwner,
} from '../src/main/sessions/sessions-demand-owner'
import type { SessionsCompanionSink } from '../src/main/sessions/sessions-companion-sinks'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import type { SupervisorAccess } from '../src/main/gascity/supervisor-access'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsTerminalHandle,
  localPath,
  type ProjectState,
} from '../src/shared'

const localRoot = localPath('/private/repo')
const shell = asHarnessProviderId('plain-shell')
const shellProfile = asHarnessProfileId('plain-shell-default')
const COMPANION: SessionsCompanionDemandOwner = {
  kind: 'companion',
  page: 'page-1',
  generation: 1,
}

describe('installApplicationSessionsObservation', () => {
  it('routes a companion lease to the registered sink and never to a renderer', () => {
    const world = install()
    const sink = fakeSink()
    const unregister = world.ports.companionSinks.register(sink)

    const initial = world.ports.observation.acquire(COMPANION, 1)
    world.sessions.set([retained('session-1', 'Renamed')])

    expect(sink.onProjectionChange).toHaveBeenCalledExactlyOnceWith(COMPANION, {
      demandGeneration: 1,
      revision: initial.revision + 1,
    })
    expect(world.toRenderer).not.toHaveBeenCalled()
    expect(world.sinkMissing).not.toHaveBeenCalled()
    expect(world.ports.observation.release(COMPANION, 1)).toBe(true)
    void unregister()
  })

  it('routes a renderer lease to the renderer publisher and never to the companion sink', () => {
    const world = install()
    const sink = fakeSink()
    world.ports.companionSinks.register(sink)
    const owner = rendererDemandOwner({ id: 9, generation: 2 })

    const initial = world.ports.observation.acquire(owner, 1)
    world.sessions.set([retained('session-1', 'Renamed')])

    expect(world.toRenderer).toHaveBeenCalledExactlyOnceWith(
      { id: 9, generation: 2 },
      'sessions:changed',
      { demandGeneration: 1, revision: initial.revision + 1 },
    )
    expect(sink.onProjectionChange).not.toHaveBeenCalled()
    expect(world.sinkMissing).not.toHaveBeenCalled()
    world.ports.observation.release(owner, 1)
  })

  it('records an unregistered companion emit as a diagnostic instead of throwing', () => {
    const world = install()
    world.ports.observation.acquire(COMPANION, 1)

    expect(() => world.sessions.set([retained('session-1', 'Renamed')])).not.toThrow()
    expect(world.sinkMissing).toHaveBeenCalledExactlyOnceWith('sessions:changed')
    expect(world.toRenderer).not.toHaveBeenCalled()
    world.ports.observation.release(COMPANION, 1)
  })

  it('carries transcript changes for a companion lease through the same sink', async () => {
    const world = install()
    const sink = fakeSink()
    world.ports.companionSinks.register(sink)
    const projection = world.ports.observation.acquire(COMPANION, 1)

    world.ports.transcripts.acquire(COMPANION, {
      demandGeneration: 1,
      projectionDemandGeneration: 1,
      sourceRevision: projection.revision,
      handle: asSessionsTerminalHandle('session-1'),
    })
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()

    expect(sink.onTranscriptChange).toHaveBeenCalledWith(
      COMPANION,
      expect.objectContaining({ demandGeneration: 1 }),
    )
    expect(world.toRenderer).not.toHaveBeenCalled()
    world.ports.transcripts.release(COMPANION, 1)
    world.ports.observation.release(COMPANION, 1)
  })

  it('keeps Open and attach renderer verbs: a companion owner reaching them throws', () => {
    const world = install()
    const projection = world.ports.observation.acquire(COMPANION, 1)
    const session = projection.sessions[0]!
    const workspace = projection.workspaces[0]!
    const request = {
      demandGeneration: 1,
      sourceRevision: projection.revision,
      handle: session.handle,
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      workspaceQualifier: workspace.qualifier,
    }

    expect(() => world.ports.observation.resolveOpen(COMPANION, request)).toThrow(
      'Sessions open is a renderer verb',
    )
    expect(() =>
      world.ports.observation.resolveExternalAttach(COMPANION, request),
    ).toThrow('Sessions attach is a renderer verb')
    world.ports.observation.release(COMPANION, 1)
  })
})

function install() {
  const sessions = observationSource([retained('session-1', 'Shell')])
  const toRenderer = vi.fn()
  const sinkMissing = vi.fn()
  const supervisor: SupervisorAccess = {
    address: () => Promise.resolve({ ok: false, failure: { reason: 'disabled' } }),
  }
  const ports = installApplicationSessionsObservation(
    { own: (_label, resource) => resource },
    { state: projectState, observe: listeners().observe },
    { listHosts: () => hostOptions() },
    sessions,
    {
      ...observationSource([]),
      resolveUsageObservation: () => ({ status: 'pending' as const }),
    },
    {
      events: { toRenderer },
      diagnostics: { recordSessionsCompanionSinkMissing: sinkMissing },
    },
    supervisor,
  )
  return { ports, sessions, toRenderer, sinkMissing }
}

function fakeSink(): {
  readonly onProjectionChange: Mock<SessionsCompanionSink['onProjectionChange']>
  readonly onUsageChange: Mock<SessionsCompanionSink['onUsageChange']>
  readonly onTranscriptChange: Mock<SessionsCompanionSink['onTranscriptChange']>
} {
  return {
    onProjectionChange: vi.fn(),
    onUsageChange: vi.fn(),
    onTranscriptChange: vi.fn(),
  }
}

function projectState(): ProjectState {
  const projectId = `project:${localRoot.hostId}:${localRoot.path}`
  const workspaceId = `workspace:${localRoot.hostId}:${localRoot.path}`
  return {
    revision: 1,
    root: localRoot,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: projectId,
    activeWorkspaceId: workspaceId,
    projects: [
      {
        id: projectId,
        registeredRoot: localRoot,
        displayName: 'Local project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: workspaceId,
        workspaces: [
          {
            id: workspaceId,
            root: localRoot,
            name: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function hostOptions() {
  return [
    {
      hostId: 'local',
      label: 'Local',
      kind: 'local' as const,
      connectionState: 'connected' as const,
      watchTier: 'native' as const,
    },
  ]
}

function retained(id: string, title: string): OwnedTerminalSession {
  return {
    id,
    providerId: shell,
    profileId: shellProfile,
    launchRevision: 1,
    recoverySkipCount: 0,
    artifactIdentity: '0123456789abcdef01234567',
    harnessSessionId: 'provider-session-secret',
    hostId: localRoot.hostId,
    workspaceRoot: localRoot,
    cwd: localRoot,
    title,
    position: 0,
    active: true,
    updatedAt: 1,
  }
}

function observationSource<T>(initial: readonly T[]) {
  let snapshot = initial
  const observed = listeners()
  return {
    observationSnapshot: () => snapshot,
    observe: observed.observe,
    set: (next: readonly T[]) => {
      snapshot = next
      observed.publish()
    },
  }
}

function listeners() {
  const values = new Set<() => void>()
  return {
    observe: (listener: () => void) => {
      values.add(listener)
      return () => {
        values.delete(listener)
      }
    },
    publish: () => {
      for (const listener of values) listener()
    },
  }
}
