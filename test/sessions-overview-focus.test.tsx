// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsPtyHandle,
  asSessionsProjectHandle,
  SESSIONS_HVIR_ORIGIN,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  asSessionsWorkspaceRuntimeId,
  localPath,
  sessionsWorkspaceQualifier,
  type SessionsObservationSnapshot,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
  type SessionsTerminalResolutionResponse,
  type SessionsUsageDemandTarget,
  type SessionsUsageSnapshot,
} from '../src/shared'
import type { SessionsTerminalSurfacePort } from '../src/renderer/src/sessions/sessions-terminal-surface'
let host: HTMLDivElement
let root: Root
let focused = true

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  focused = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('SessionsOverview', () => {
  it('distinguishes the true empty state from a filtered empty state', async () => {
    installApi({
      snapshot: (demandGeneration) => ({
        ...snapshot(demandGeneration),
        sessions: [],
      }),
    })
    await renderOverview({
      observation: { snapshot: () => [], subscribe: () => () => undefined },
    })

    expect(host.textContent).toContain('No hvir sessions')
    expect(host.textContent).not.toContain('No sessions match')
    expect(host.querySelector('button')?.textContent).not.toBe('Reset filters')
  })

  it('rejects a late Open completion after the destination lifetime ends', async () => {
    let complete!: (response: SessionsOpenResponse) => void
    const pending = new Promise<SessionsOpenResponse>((resolve) => {
      complete = resolve
    })
    installApi({ open: () => pending })
    const onOpened = vi.fn()
    const onFocusOpened = vi.fn(() => Promise.resolve(true))
    await renderOverview({ onOpened, onFocusOpened })

    await act(async () => {
      button('Open', '.session-card').click()
      await settle()
    })
    await act(async () => {
      root.render(<div>Workspace</div>)
      await settle()
    })
    await act(async () => {
      complete(openedResponse())
      await settle()
    })

    expect(onOpened).not.toHaveBeenCalled()
    expect(onFocusOpened).not.toHaveBeenCalled()
  })

  it('moves focus to a deterministic neighbor when the selected row disappears', async () => {
    let current = snapshot(1)
    const api = installApi({
      snapshot: (demandGeneration) => ({ ...current, demandGeneration }),
    })
    await renderOverview({
      observation: { snapshot: () => [], subscribe: () => () => undefined },
    })
    const cards = [...host.querySelectorAll<HTMLElement>('.session-card')]
    act(() => cards[1]?.focus())

    current = { ...current, revision: 8, sessions: current.sessions.slice(0, 1) }
    await act(async () => {
      api.emit({ demandGeneration: 1, revision: 8 })
      await settle()
    })

    expect(host.querySelectorAll('.session-card')).toHaveLength(1)
    expect(document.activeElement).toBe(host.querySelector('.session-card'))
  })

  it('mounts a bounded accessible page at projection capacity and moves keyboard focus across pages', async () => {
    installApi({ snapshot: capacitySnapshot })
    await renderOverview({
      observation: {
        snapshot: capacityRendererSessions,
        subscribe: () => () => undefined,
      },
    })

    expect(host.textContent).toContain(
      `Showing 1–40 of ${MAX_SESSIONS_PROJECTION_ROWS} sessions`,
    )
    expect(host.textContent).toContain('Page 1 of 13')
    expect(host.querySelectorAll('[role="list"]')).toHaveLength(1)
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(40)
    expect(host.querySelectorAll('.session-card[tabindex="0"]')).toHaveLength(1)

    const last = host.querySelectorAll<HTMLElement>('.session-card')[39]
    await act(async () => {
      last?.focus()
      last?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
      await settle()
    })

    expect(host.textContent).toContain(
      `Showing 41–80 of ${MAX_SESSIONS_PROJECTION_ROWS} sessions`,
    )
    expect(host.querySelectorAll('.session-card')).toHaveLength(40)
    expect(document.activeElement).toBe(host.querySelector('.session-card'))
  })

  it('replaces Opening feedback when an unavailable Open completes after a projection revision', async () => {
    let current = snapshot(1)
    let complete!: (response: SessionsOpenResponse) => void
    const pending = new Promise<SessionsOpenResponse>((resolve) => {
      complete = resolve
    })
    const api = installApi({
      snapshot: (demandGeneration) => ({ ...current, demandGeneration }),
      open: () => pending,
    })
    await renderOverview()

    await act(async () => {
      button('Open', '.session-card').click()
      await settle()
    })
    expect(host.textContent).toContain('Opening exact terminal…')
    current = {
      ...current,
      revision: 8,
      workspaces: current.workspaces.map((workspace) => ({
        ...workspace,
        projectName: 'Project One updated',
      })),
    }
    await act(async () => {
      api.emit({ demandGeneration: 1, revision: 8 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await settle()
    })
    await act(async () => {
      complete({ outcome: 'unavailable', reason: 'terminal-unavailable' })
      await settle()
    })

    expect(host.textContent).not.toContain('Opening exact terminal…')
    expect(host.textContent).toContain(
      'Sessions changed. Review the refreshed row before opening it.',
    )
  })

  it('preserves free-text identifiers and presents missing provider capability truthfully', async () => {
    installApi({
      snapshot: (demandGeneration) => {
        const current = snapshot(demandGeneration)
        return {
          ...current,
          providers: [],
          workspaces: current.workspaces.map((workspace) => ({
            ...workspace,
            host: { ...workspace.host, label: 'gpu-east-1' },
          })),
          sessions: current.sessions.map((session, index) =>
            index === 0
              ? {
                  ...session,
                  telemetry: {
                    ...session.telemetry,
                    model: { status: 'available', value: { id: 'gpt-5.6-sol' } },
                  },
                }
              : session,
          ),
        }
      },
    })
    await renderOverview()

    expect(host.textContent).not.toContain('Hostgpu-east-1 · Connected')
    expect(host.textContent).toContain('Modelgpt-5.6-sol')
    expect(host.textContent).toContain('Terminal')
    expect(host.textContent).not.toContain('Gpu east 1')
    expect(host.textContent).not.toContain('Gpt 5.6 sol')
  })
})
function installApi(
  options: {
    readonly snapshot?: (demandGeneration: number) => SessionsObservationSnapshot
    readonly open?: (request: unknown) => Promise<SessionsOpenResponse>
    readonly resolveTerminal?: (
      request: unknown,
    ) => Promise<SessionsTerminalResolutionResponse>
    readonly usageSnapshot?: (
      demandGeneration: number,
      targets: readonly SessionsUsageDemandTarget[],
    ) => SessionsUsageSnapshot
  } = {},
) {
  const listeners = new Set<(payload: unknown) => void>()
  const usageListeners = new Set<(payload: unknown) => void>()
  const readSnapshot = options.snapshot ?? snapshot
  const observe = vi.fn((generation: number) => Promise.resolve(readSnapshot(generation)))
  const release = vi.fn((_generation: number) => Promise.resolve())
  const open = vi.fn(
    options.open ?? ((_request: unknown) => Promise.resolve(openedResponse())),
  )
  const resolveTerminal = vi.fn(
    options.resolveTerminal ??
      ((request: unknown) => {
        const exact = request as SessionsOpenRequest
        return Promise.resolve({
          outcome: 'resolved' as const,
          handle: exact.handle,
          workspaceQualifier: exact.workspaceQualifier,
          workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-runtime'),
          livePty: exact.livePty,
        })
      }),
  )
  let usageTargets: readonly SessionsUsageDemandTarget[] = []
  const readUsageSnapshot =
    options.usageSnapshot ??
    ((demandGeneration: number, targets: readonly SessionsUsageDemandTarget[]) => ({
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration,
      revision: 1,
      sampledAt: 10_000,
      rows: targets.map((target) => ({
        handle: target.handle,
        usage: { status: 'pending' as const, reason: 'observation-pending' as const },
      })),
    }))
  const usageObserve = vi.fn(
    (request: {
      demandGeneration: number
      targets: readonly SessionsUsageDemandTarget[]
    }) => {
      usageTargets = request.targets
      return Promise.resolve(readUsageSnapshot(request.demandGeneration, usageTargets))
    },
  )
  const usageSnapshot = vi.fn((demandGeneration: number) =>
    Promise.resolve(readUsageSnapshot(demandGeneration, usageTargets)),
  )
  const usageRelease = vi.fn((_demandGeneration: number) => Promise.resolve())
  const api = {
    observe,
    release,
    open,
    resolveTerminal,
    emit: (payload: unknown) => {
      for (const listener of listeners) listener(payload)
    },
    usageEmit: (payload: unknown) => {
      for (const listener of usageListeners) listener(payload)
    },
    usageObserve,
    usageSnapshot,
    usageRelease,
    usageListenerCount: () => usageListeners.size,
    listenerCount: () => listeners.size,
    invoke: vi.fn((channel: string, request: { demandGeneration: number }) => {
      if (channel === 'sessions:observe') return observe(request.demandGeneration)
      if (channel === 'sessions:snapshot')
        return Promise.resolve(readSnapshot(request.demandGeneration))
      if (channel === 'sessions:release') return release(request.demandGeneration)
      if (channel === 'sessions:usage-observe') return usageObserve(request as never)
      if (channel === 'sessions:usage-snapshot')
        return usageSnapshot(request.demandGeneration)
      if (channel === 'sessions:usage-release')
        return usageRelease(request.demandGeneration)
      if (channel === 'sessions:open') return open(request)
      if (channel === 'sessions:resolve-terminal') return resolveTerminal(request)
      return Promise.reject(new Error(`Unexpected channel ${channel}`))
    }),
    on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
      const selected =
        channel === 'sessions:changed'
          ? listeners
          : channel === 'sessions:usage-changed'
            ? usageListeners
            : undefined
      selected?.add(listener)
      return () => selected?.delete(listener)
    }),
  }
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: api,
  })
  return api
}

function openedResponse(): SessionsOpenResponse {
  return {
    outcome: 'opened',
    state: projectState(),
    handle: asSessionsTerminalHandle('terminal-private-agent'),
    workspaceQualifier: sessionsWorkspaceQualifier(11, 0, 0),
    livePty: {
      handle: asSessionsPtyHandle('live-instance-agent'),
      rendererOwnerId: 4,
      rendererGeneration: 6,
    },
  }
}

async function renderOverview(
  overrides: Partial<Parameters<typeof SessionsOverview>[0]> = {},
  strict = false,
): Promise<void> {
  await act(async () => {
    const overview = (
      <SessionsOverview
        observation={{
          snapshot: rendererSessions,
          subscribe: () => () => undefined,
        }}
        surface={availableSurface(() => ({
          outcome: 'unavailable',
          reason: 'runtime-not-ready',
        }))}
        onOpened={vi.fn()}
        onFocusOpened={vi.fn(() => Promise.resolve(true))}
        onOpenFailed={vi.fn()}
        onAttachExternal={vi.fn(() => Promise.resolve(true))}
        {...overrides}
      />
    )
    root.render(strict ? <StrictMode>{overview}</StrictMode> : overview)
    await settle()
  })
}

function availableSurface(
  acquire: SessionsTerminalSurfacePort['acquire'],
): SessionsTerminalSurfacePort {
  return {
    acquire,
  }
}

function rendererSessions() {
  const workspaceQualifier = sessionsWorkspaceQualifier(11, 0, 0)
  return [
    {
      handle: asSessionsTerminalHandle('terminal-private-agent'),
      workspaceQualifier,
      providerId: asHarnessProviderId('codex'),
      profileId: asHarnessProfileId('codex-default'),
      title: 'Review release notes',
      dormant: false,
      resumeOnStart: false,
      exited: false,
      recoveryUnavailable: false,
      attention: 'bell' as const,
    },
    {
      handle: asSessionsTerminalHandle('terminal-private-shell'),
      workspaceQualifier,
      providerId: asHarnessProviderId('plain-shell'),
      profileId: asHarnessProfileId('plain-shell-default'),
      title: 'Deploy preview shell',
      dormant: false,
      resumeOnStart: false,
      exited: false,
      recoveryUnavailable: false,
    },
  ]
}

function snapshot(demandGeneration: number): SessionsObservationSnapshot {
  const unsupported = { status: 'unsupported' as const }
  const workspaceQualifier = sessionsWorkspaceQualifier(11, 0, 0)
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision: 7,
    activeProject: asSessionsProjectHandle('opaque-project'),
    providers: [
      {
        id: asHarnessProviderId('codex'),
        displayName: 'Codex',
        telemetrySupported: true,
        usageSupported: true,
        sessionKind: 'agent',
      },
      {
        id: asHarnessProviderId('plain-shell'),
        displayName: 'Shell',
        telemetrySupported: false,
        usageSupported: false,
        sessionKind: 'shell',
      },
    ],
    workspaces: [
      {
        projectId: asSessionsProjectHandle('opaque-project'),
        projectName: 'Project One',
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        qualifier: workspaceQualifier,
        workspaceName: 'main',
        main: true,
        closed: false,
        missing: false,
        host: {
          id: 'local',
          label: 'Local',
          kind: 'local',
          connectionState: 'connected',
        },
      },
    ],
    sessions: [
      {
        handle: asSessionsTerminalHandle('terminal-private-agent'),
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        origin: SESSIONS_HVIR_ORIGIN,
        providerId: asHarnessProviderId('codex'),
        profile: {
          status: 'available',
          value: { id: asHarnessProfileId('codex-default') },
        },
        title: 'Review release notes',
        lifecycle: 'live',
        livePty: {
          handle: asSessionsPtyHandle('live-instance-agent'),
          rendererOwnerId: 4,
          rendererGeneration: 6,
        },
        telemetry: {
          model: { status: 'available', value: { id: 'model-safe' } },
          context: { status: 'available', value: { usedTokens: 120, usedPercent: 12 } },
          turn: { status: 'available', value: { state: 'idle' } },
          freshness: { status: 'available', value: { staleAfterMs: 30_000 } },
        },
      },
      {
        handle: asSessionsTerminalHandle('terminal-private-shell'),
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        origin: SESSIONS_HVIR_ORIGIN,
        providerId: asHarnessProviderId('plain-shell'),
        profile: {
          status: 'available',
          value: { id: asHarnessProfileId('plain-shell-default') },
        },
        title: 'Deploy preview shell',
        lifecycle: 'retained',
        telemetry: {
          model: unsupported,
          context: unsupported,
          turn: unsupported,
          freshness: unsupported,
        },
      },
    ],
  }
}

function capacitySnapshot(demandGeneration: number): SessionsObservationSnapshot {
  const base = snapshot(demandGeneration)
  const fixture = base.sessions[0]!
  return {
    ...base,
    sessions: Array.from({ length: MAX_SESSIONS_PROJECTION_ROWS }, (_, index) => ({
      ...fixture,
      handle: asSessionsTerminalHandle(`capacity-${index}`),
      title: `Capacity session ${index}`,
      lifecycle: 'retained' as const,
      livePty: undefined,
    })),
  }
}

function capacityRendererSessions() {
  const fixture = rendererSessions()[0]!
  return Array.from({ length: MAX_SESSIONS_PROJECTION_ROWS }, (_, index) => ({
    ...fixture,
    handle: asSessionsTerminalHandle(`capacity-${index}`),
    title: `Capacity session ${index}`,
    attention: undefined,
  }))
}

function projectState() {
  const root = localPath('/repo')
  return {
    revision: 12,
    root,
    connectionState: 'connected' as const,
    watchTier: 'native' as const,
    activeProjectId: 'project-real',
    activeWorkspaceId: 'workspace-real',
    projects: [
      {
        id: 'project-real',
        registeredRoot: root,
        displayName: 'Project One',
        connectionState: 'connected' as const,
        watchTier: 'native' as const,
        activeWorkspaceId: 'workspace-real',
        workspaces: [
          {
            id: 'workspace-real',
            root,
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

function button(text: string, within?: string): HTMLButtonElement {
  const rootElement = within ? host.querySelector(within) : host
  const match = [
    ...(rootElement?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((candidate) => candidate.textContent?.trim() === text)
  if (!match) throw new Error(`Missing button ${text}`)
  return match
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
