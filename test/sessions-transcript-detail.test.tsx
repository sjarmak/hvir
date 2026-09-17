// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import {
  SESSIONS_PROJECTION_VERSION,
  SESSIONS_TRANSCRIPT_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  asSessionsExternalAttachTicket,
  localPath,
  sessionsWorkspaceQualifier,
  type ProjectState,
  type SessionsAttachExternalResponse,
  type SessionsObservationSnapshot,
  type SessionsTranscriptSnapshot,
} from '../src/shared'

const EXTERNAL = asSessionsTerminalHandle('external-row')
const workspaceQualifier = sessionsWorkspaceQualifier(11, 0, 0)

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Sessions transcript detail', () => {
  it('reads one row under the list lease, follows it live, and releases it on hide', async () => {
    const api = installApi()
    await render()

    await act(async () => {
      button('Interact').click()
      await settle()
    })
    expect(api.transcriptObserve).toHaveBeenCalledWith({
      demandGeneration: 1,
      projectionDemandGeneration: 1,
      sourceRevision: 7,
      handle: EXTERNAL,
    })
    const pane = host.querySelector('.sessions-transcript-detail')!
    expect(pane.querySelector('h1')?.textContent).toBe('Refactor the planner')
    expect(pane.textContent).toContain('Gas City')
    expect([...pane.querySelectorAll('.sessions-transcript-turn')].map(text)).toEqual([
      'Usership the panel',
      'AgentReading the source.',
    ])
    expect(api.transcriptListenerCount()).toBe(1)

    api.reply({
      ...transcript(1),
      revision: 2,
      turns: [
        ...transcript(1).turns,
        { ordinal: 2, role: 'user', kind: 'text', text: 'thanks' },
      ],
    })
    await act(async () => {
      api.transcriptEmit({ demandGeneration: 1, revision: 2, handle: EXTERNAL })
      await settle()
    })
    expect(
      [...host.querySelectorAll('.sessions-transcript-turn')].map(text).at(-1),
    ).toBe('Userthanks')

    // One selected row, one stream. Hiding Sessions leaves none at all.
    focused = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await settle()
    })
    expect(api.transcriptRelease).toHaveBeenCalledWith({ demandGeneration: 1 })
    expect(host.querySelector('.sessions-transcript-detail')).toBeNull()
    expect(api.transcriptListenerCount()).toBe(0)
  })

  it('reports a lost stream and reconnects only when asked', async () => {
    const api = installApi({ transcript: () => ({ ...transcript(1), stream: 'lost', streamReason: 'unreachable' }) })
    await render()
    await act(async () => {
      button('Interact').click()
      await settle()
    })
    expect(status()).toContain('Showing 2 turns.')
    expect(status()).toContain('The Gas City supervisor is not reachable on this host.')
    expect(status()).toContain('Reconnect to follow it again.')
    expect(api.transcriptResume).not.toHaveBeenCalled()

    api.reply({ ...transcript(1), revision: 2 })
    await act(async () => {
      button('Reconnect').click()
      await settle()
    })
    expect(api.transcriptResume).toHaveBeenCalledWith({ demandGeneration: 1 })
    expect(status()).toContain('Following live.')
  })

  it('reports an unreachable supervisor and still attaches a terminal to the session', async () => {
    const api = installApi({
      transcript: () => ({
        version: SESSIONS_TRANSCRIPT_VERSION,
        demandGeneration: 1,
        revision: 1,
        handle: EXTERNAL,
        status: 'unavailable',
        reason: 'unreachable',
        stream: 'closed',
        turns: [],
        older: false,
        dropped: 0,
      }),
    })
    const onOpened = vi.fn()
    const onAttachExternal = vi.fn(() => Promise.resolve(true))
    await render({ onOpened, onAttachExternal })
    await act(async () => {
      button('Interact').click()
      await settle()
    })
    expect(status()).toBe('The Gas City supervisor is not reachable on this host.')
    expect(host.querySelectorAll('.sessions-transcript-turn')).toHaveLength(0)

    await act(async () => {
      button('Attach').click()
      await settle()
    })
    expect(api.attachExternal).toHaveBeenCalledWith({
      demandGeneration: 1,
      sourceRevision: 7,
      handle: EXTERNAL,
      projectId: asSessionsProjectHandle('opaque-project'),
      workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
      workspaceQualifier,
    })
    expect(onOpened).toHaveBeenCalledTimes(1)
    expect(onAttachExternal).toHaveBeenCalledWith('workspace-real', {
      command: "gc session attach 'mem-worker-1'",
      key: 'gc:mem-worker-1',
      ticket: asSessionsExternalAttachTicket('a'.repeat(32)),
    })
    // The pane closes with the attach: the terminal is the surface now.
    expect(host.querySelector('.sessions-transcript-detail')).toBeNull()
    expect(api.transcriptRelease).toHaveBeenCalledWith({ demandGeneration: 1 })
  })

  it('says why the attach could not run, without opening a transcript stream for it', async () => {
    const api = installApi({
      attach: () => ({ outcome: 'unavailable', reason: 'connection-unavailable' }),
    })
    const onAttachExternal = vi.fn(() => Promise.resolve(true))
    await render({ onAttachExternal })
    await act(async () => {
      button('Interact').click()
      await settle()
    })
    await act(async () => {
      button('Attach').click()
      await settle()
    })
    expect(onAttachExternal).not.toHaveBeenCalled()
    expect(host.querySelector('.sessions-feedback')?.textContent).toBe(
      'The host is disconnected. Reconnect from the workspace before attaching.',
    )
    expect(api.attachExternal).toHaveBeenCalledTimes(1)
  })

  it('shows the borrowed terminal first for a row hvir already owns, and toggles to the transcript', async () => {
    const api = installApi({ live: true })
    await render()

    await act(async () => {
      button('Interact').click()
      await settle()
    })
    expect(host.querySelector('.sessions-detail-terminal')).not.toBeNull()
    expect(host.querySelector('.sessions-transcript-detail')).toBeNull()
    expect(api.transcriptObserve).not.toHaveBeenCalled()

    await act(async () => {
      button('Show transcript').click()
      await settle()
    })
    expect(host.querySelector('.sessions-detail-terminal')).toBeNull()
    expect(api.transcriptObserve).toHaveBeenCalledTimes(1)
    expect(host.querySelectorAll('.sessions-transcript-turn')).toHaveLength(2)

    await act(async () => {
      button('Show terminal').click()
      await settle()
    })
    expect(host.querySelector('.sessions-transcript-detail')).toBeNull()
    expect(host.querySelector('.sessions-detail-terminal')).not.toBeNull()
    expect(api.transcriptRelease).toHaveBeenCalledWith({ demandGeneration: 1 })
  })
})

async function render(
  overrides: Partial<Parameters<typeof SessionsOverview>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsOverview
        observation={{ snapshot: () => [], subscribe: () => () => undefined }}
        surface={{
          acquire: () => ({ outcome: 'unavailable', reason: 'runtime-not-ready' }),
        }}
        onOpened={vi.fn()}
        onFocusOpened={vi.fn(() => Promise.resolve(true))}
        onOpenFailed={vi.fn()}
        onAttachExternal={vi.fn(() => Promise.resolve(true))}
        {...overrides}
      />,
    )
    await settle()
  })
}

function installApi(
  options: {
    readonly live?: boolean
    readonly transcript?: (demandGeneration: number) => SessionsTranscriptSnapshot
    readonly attach?: () => SessionsAttachExternalResponse
  } = {},
) {
  const transcriptListeners = new Set<(payload: unknown) => void>()
  let next = options.transcript ?? transcript
  const transcriptObserve = vi.fn((request: { demandGeneration: number }) =>
    Promise.resolve(next(request.demandGeneration)),
  )
  const transcriptSnapshot = vi.fn((request: { demandGeneration: number }) =>
    Promise.resolve(next(request.demandGeneration)),
  )
  const transcriptResume = vi.fn((request: { demandGeneration: number }) =>
    Promise.resolve(next(request.demandGeneration)),
  )
  const transcriptRelease = vi.fn((_request: unknown) => Promise.resolve())
  const attachExternal = vi.fn((_request: unknown) =>
    Promise.resolve(options.attach?.() ?? attached()),
  )
  const api = {
    transcriptObserve,
    transcriptResume,
    transcriptRelease,
    attachExternal,
    /** What the next read of the transcript answers. */
    reply: (snapshot: SessionsTranscriptSnapshot) => {
      next = () => snapshot
    },
    transcriptEmit: (payload: unknown) => {
      for (const listener of transcriptListeners) listener(payload)
    },
    transcriptListenerCount: () => transcriptListeners.size,
    invoke: vi.fn((channel: string, request: { demandGeneration: number }) => {
      switch (channel) {
        case 'sessions:observe':
        case 'sessions:snapshot':
          return Promise.resolve(observation(request.demandGeneration, options.live))
        case 'sessions:release':
          return Promise.resolve()
        case 'sessions:transcript-observe':
          return transcriptObserve(request)
        case 'sessions:transcript-snapshot':
          return transcriptSnapshot(request)
        case 'sessions:transcript-resume':
          return transcriptResume(request)
        case 'sessions:transcript-release':
          return transcriptRelease(request)
        case 'sessions:attach-external':
          return attachExternal(request)
        case 'sessions:resolve-terminal':
          return Promise.resolve({ outcome: 'unavailable', reason: 'session-unavailable' })
        default:
          return Promise.reject(new Error(`Unexpected channel ${channel}`))
      }
    }),
    on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
      if (channel !== 'sessions:transcript-changed') return () => undefined
      transcriptListeners.add(listener)
      return () => transcriptListeners.delete(listener)
    }),
  }
  Object.defineProperty(window, 'hvir', { configurable: true, value: api })
  return api
}

function observation(
  demandGeneration: number,
  live = false,
): SessionsObservationSnapshot {
  const unsupported = { status: 'unsupported' as const }
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision: 7,
    activeProject: asSessionsProjectHandle('opaque-project'),
    providers: [
      {
        id: asHarnessProviderId('claude'),
        displayName: 'Claude',
        telemetrySupported: false,
        usageSupported: false,
        sessionKind: 'agent',
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
        handle: EXTERNAL,
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        origin: { kind: 'external-agent', sourceId: 'gas-city', sourceName: 'Gas City' },
        providerId: asHarnessProviderId('claude'),
        profile: { status: 'available', value: { id: asHarnessProfileId('claude') } },
        title: 'Refactor the planner',
        lifecycle: live ? 'live' : 'retained',
        ...(live
          ? {
              livePty: {
                handle: asSessionsPtyHandle('live-instance-external'),
                rendererOwnerId: 4,
                rendererGeneration: 6,
              },
            }
          : {}),
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

function transcript(demandGeneration: number): SessionsTranscriptSnapshot {
  return {
    version: SESSIONS_TRANSCRIPT_VERSION,
    demandGeneration,
    revision: 1,
    handle: EXTERNAL,
    status: 'ready',
    stream: 'live',
    turns: [
      { ordinal: 0, role: 'user', kind: 'text', text: 'ship the panel' },
      { ordinal: 1, role: 'assistant', kind: 'text', text: 'Reading the source.' },
    ],
    older: false,
    dropped: 0,
  }
}

function attached(): SessionsAttachExternalResponse {
  return {
    outcome: 'attached',
    state: projectState(),
    handle: EXTERNAL,
    target: {
      command: "gc session attach 'mem-worker-1'",
      key: 'gc:mem-worker-1',
      ticket: asSessionsExternalAttachTicket('a'.repeat(32)),
    },
  }
}

function projectState(): ProjectState {
  const root = localPath('/repo')
  return {
    revision: 12,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-real',
    activeWorkspaceId: 'workspace-real',
    projects: [
      {
        id: 'project-real',
        registeredRoot: root,
        displayName: 'Project One',
        connectionState: 'connected',
        watchTier: 'native',
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

/** The one line the transcript pane uses to say what it is showing. */
function status(): string {
  const element = host.querySelector('.sessions-transcript-detail .sessions-detail-status')
  if (!element) throw new Error('Missing transcript status')
  return text(element)
}

function text(element: Element): string {
  return element.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
