// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import { NeedsYouView } from '../src/renderer/src/needs-you/NeedsYouView'
import { sessionsProjectionFixture } from './sessions-projection-fixture'
import {
  asHarnessProviderId,
  asHostId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  hostPath,
  SESSIONS_HVIR_ORIGIN,
  sessionsWorkspaceQualifier,
  type HvirApi,
  type NeedsYouSnapshot,
  type SessionsProjectionRow,
} from '../src/shared'

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<
  typeof vi.fn<
    (channel: string, request: { demandGeneration: number }) => Promise<unknown>
  >
>
let focused: MockInstance<() => boolean>
const onBead = vi.fn(() => Promise.resolve())
const onError = vi.fn()
const interact = (action: () => void) =>
  act(async () => {
    action()
    await Promise.resolve()
  })
const sourceRoot = hostPath(asHostId('local'), '/repo')
const response: Omit<NeedsYouSnapshot, 'demandGeneration'> = {
  version: 1,
  revision: 1,
  observedAt: 10,
  sources: [
    {
      projectId: 'project',
      workspaceId: 'workspace',
      projectName: 'Project',
      workspaceName: 'main',
      root: sourceRoot,
      hostId: 'local',
      beads: {
        observedAt: 10,
        response: {
          available: true,
          readyIds: [],
          dispatchableIds: [],
          dispatchabilitySource: 'structural',
          dependencies: [],
          gates: [],
          issues: [
            {
              id: 'bead-1',
              title: 'Choose target',
              status: 'open',
              priority: 2,
              issueType: 'decision',
              labels: [],
              dependencyCount: 0,
              dependentCount: 0,
            },
          ],
        },
      },
      pulls: {
        observedAt: 10,
        response: { available: false, reason: 'error', message: 'GitHub unavailable' },
      },
    },
  ],
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  invoke = vi.fn((channel: string, request: { demandGeneration: number }) =>
    Promise.resolve(
      channel === 'needs-you:release'
        ? undefined
        : { ...response, demandGeneration: request.demandGeneration },
    ),
  )
  Object.assign(window, {
    hvir: { invoke, on: () => () => undefined } as unknown as HvirApi,
  })
})

afterEach(async () => {
  await interact(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const onSession = vi.fn()
const onOpened = vi.fn()
const onFocusOpened = vi.fn(() => Promise.resolve(true))

const render = async (projection = sessionsProjectionFixture()) =>
  interact(() =>
    root.render(
      <NeedsYouView
        projection={projection}
        onSession={onSession}
        onOpened={onOpened}
        onFocusOpened={onFocusOpened}
        onBead={onBead}
        onError={onError}
      />,
    ),
  )

const unsupported = { status: 'unsupported' as const }
const liveRow: SessionsProjectionRow = {
  handle: asSessionsTerminalHandle('terminal'),
  origin: SESSIONS_HVIR_ORIGIN,
  project: { id: asSessionsProjectHandle('project'), name: 'Project' },
  workspace: {
    id: asSessionsWorkspaceHandle('workspace'),
    name: 'main',
    main: true,
    qualifier: sessionsWorkspaceQualifier(1, 0, 0),
  },
  host: { id: 'local', label: 'Local', kind: 'local', connectionState: 'connected' },
  provider: { id: asHarnessProviderId('codex'), name: 'Codex', kind: 'agent' },
  profile: unsupported,
  title: 'Waiting session',
  lifecycle: 'live',
  connectionState: 'connected',
  attention: { status: 'available', value: 'prompt' },
  working: unsupported,
  model: unsupported,
  context: unsupported,
  turn: unsupported,
  telemetryFreshness: unsupported,
  usage: unsupported,
  livePty: {
    handle: asSessionsPtyHandle('pty'),
    rendererOwnerId: 1,
    rendererGeneration: 2,
  },
}

const projectionWith = (row: SessionsProjectionRow) => {
  const projection = sessionsProjectionFixture()
  const snapshot = {
    ...projection.snapshot(),
    demandGeneration: 7,
    sourceRevision: 9,
    rows: [row],
  }
  Object.assign(projection, { snapshot: () => snapshot })
  return projection
}

const sessionButton = () =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Waiting session'),
  )!

const openedResponse = {
  outcome: 'opened' as const,
  state: { projects: [] },
  handle: liveRow.handle,
  workspaceQualifier: liveRow.workspace.qualifier,
  livePty: liveRow.livePty,
}

describe('Needs you view', () => {
  it('pages a bounded list with native controls without dropping targets', async () => {
    const source = response.sources[0]!
    if (!source.beads.response.available) throw new Error('Expected available fixture')
    const issue = source.beads.response.issues[0]!
    const snapshot = {
      ...response,
      sources: [
        {
          ...source,
          beads: {
            ...source.beads,
            response: {
              ...source.beads.response,
              issues: Array.from({ length: 51 }, (_, index) => ({
                ...issue,
                id: `bead-${index}`,
                title: `Decision ${index}`,
              })),
            },
          },
        },
      ],
    }
    invoke.mockImplementation((channel, request) =>
      Promise.resolve(
        channel === 'needs-you:release'
          ? undefined
          : { ...snapshot, demandGeneration: request.demandGeneration },
      ),
    )
    await render()
    expect(container.querySelectorAll('.needs-you-list li')).toHaveLength(50)
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find(
        (value) => value.textContent === label,
      )!
    await interact(() => button('Next').click())
    expect(container.querySelectorAll('.needs-you-list li')).toHaveLength(1)
    expect(button('Next').disabled).toBe(true)
    await interact(() => button('Previous').click())
    expect(container.querySelectorAll('.needs-you-list li')).toHaveLength(50)
    expect(button('Previous').disabled).toBe(true)
  })

  it('shows a current navigation failure and re-enables the target', async () => {
    onBead.mockRejectedValueOnce(new Error('Workspace unavailable'))
    await render()
    const button = container.querySelector<HTMLButtonElement>('.needs-you-list button')!
    await interact(() => button.click())
    expect(container.textContent).toContain('Workspace unavailable')
    expect(button.disabled).toBe(false)
  })

  it('discloses omitted workspaces and truncated source reads', async () => {
    invoke.mockImplementation((channel, request) =>
      Promise.resolve(
        channel === 'needs-you:release'
          ? undefined
          : {
              ...response,
              demandGeneration: request.demandGeneration,
              candidateLimit: 128,
              omittedSourceCount: 2,
              sources: response.sources.map((source) => ({
                ...source,
                beads: { ...source.beads, truncated: true, itemLimit: 50 },
              })),
            },
      ),
    )
    await render()
    expect(container.textContent).toContain('2 workspaces omitted')
    expect(container.textContent).toContain('Partial: first 50 items needing you')
  })

  it('retries unavailable session attention with the explicit refresh', async () => {
    const retry = vi.fn()
    const failed = { status: 'unavailable' as const }
    const projection = sessionsProjectionFixture()
    Object.assign(projection, { snapshot: () => failed, retry })
    await render(projection)
    await interact(() =>
      container.querySelector<HTMLButtonElement>('.needs-you-header button')!.click(),
    )
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows partial availability and routes the exact bead with a native button', async () => {
    await render()
    expect(container.textContent).toContain('GitHub unavailable')
    expect(container.textContent).toContain('Choose target')
    expect(container.textContent).toContain('Read at')
    const button = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Choose target'),
    )!
    await interact(() => button.click())
    expect(onBead).toHaveBeenCalledWith({
      projectId: 'project',
      workspaceId: 'workspace',
      root: sourceRoot,
      beadId: 'bead-1',
    })
  })

  it('lists only sources with problems and shows decisions-store asks without a link', async () => {
    const source = response.sources[0]!
    const quiet = {
      ...source,
      workspaceName: 'quiet-worktree',
      root: hostPath(asHostId('local'), '/quiet'),
      beads: {
        observedAt: 10,
        response: {
          available: false as const,
          reason: 'no-database' as const,
          message: 'No beads database in this project.',
        },
      },
      pulls: {
        observedAt: 10,
        response: {
          available: false as const,
          reason: 'no-github-repo' as const,
          message: 'No GitHub remote is configured for this workspace',
        },
      },
    }
    if (!source.beads.response.available) throw new Error('Expected available fixture')
    const snapshot = {
      ...response,
      sources: [source, quiet],
      askStores: [
        {
          name: 'decisions',
          root: hostPath(asHostId('local'), '/city/decisions'),
          beads: {
            observedAt: 10,
            response: {
              ...source.beads.response,
              issues: [
                {
                  ...source.beads.response.issues[0]!,
                  id: 'dec-9',
                  title: 'Pick a vendor',
                },
              ],
            },
          },
        },
      ],
    }
    invoke.mockImplementation((channel, request) =>
      Promise.resolve(
        channel === 'needs-you:release'
          ? undefined
          : { ...snapshot, demandGeneration: request.demandGeneration },
      ),
    )
    await render()
    expect(container.querySelector('.needs-you-reads summary')?.textContent).toContain(
      '1 of 3 sources reported problems',
    )
    expect(container.querySelectorAll('.needs-you-reads div')).toHaveLength(1)
    expect(container.textContent).not.toContain('quiet-worktree')
    expect(container.textContent).not.toContain('No beads database')
    const ask = [...container.querySelectorAll('.needs-you-list li')].find((item) =>
      item.textContent?.includes('dec-9 · Pick a vendor'),
    )!
    expect(ask.querySelector('button, a')).toBeNull()
    expect(ask.textContent).toContain('Decision requested')
  })

  it('does not scan on a timer and releases observation when hidden', async () => {
    await render()
    expect(invoke).toHaveBeenCalledTimes(1)
    focused.mockReturnValue(false)
    await interact(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'needs-you:observe',
      'needs-you:release',
    ])
    expect(container.textContent).not.toContain('Choose target')
    expect(container.textContent).toContain('Observation paused')
  })

  it('makes read failures visible and retries only through explicit Refresh', async () => {
    invoke.mockRejectedValueOnce(new Error('Read failed'))
    await render()
    expect(container.textContent).toContain('Read failed')
    const refresh = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Refresh',
    )!
    await interact(() => refresh.click())
    expect(container.textContent).toContain('Choose target')
  })

  it('discloses omitted workspaces and partial source payloads', async () => {
    invoke.mockImplementation((channel, request) =>
      Promise.resolve(
        channel === 'needs-you:release'
          ? undefined
          : {
              ...response,
              demandGeneration: request.demandGeneration,
              candidateLimit: 128,
              omittedSourceCount: 2,
              sources: response.sources.map((source) => ({
                ...source,
                beads: { ...source.beads, truncated: true, itemLimit: 50 },
              })),
            },
      ),
    )
    await render()
    expect(container.textContent).toContain('2 workspaces omitted')
    expect(container.textContent).toContain('128-workspace read limit')
    expect(container.textContent).toContain('Partial: first 50 items needing you')
  })

  it('revokes a pending action on blur without disabling actions on return', async () => {
    let rejectAction!: (reason: Error) => void
    onBead.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectAction = reject
        }),
    )
    await render()
    const beadButton = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Choose target'),
      )!
    await interact(() => beadButton().click())
    expect(beadButton().disabled).toBe(true)
    focused.mockReturnValue(false)
    await interact(() => {
      window.dispatchEvent(new Event('blur'))
    })
    focused.mockReturnValue(true)
    await interact(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(beadButton().disabled).toBe(false)
    await interact(() => rejectAction(new Error('Obsolete action failed')))
    expect(container.textContent).not.toContain('Obsolete action failed')
  })

  it('opens the exact terminal from the projection snapshot and focuses its PTY', async () => {
    const respond = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'sessions:open'
        ? Promise.resolve(openedResponse)
        : respond(channel, request),
    )
    await render(projectionWith(liveRow))
    await interact(() => sessionButton().click())
    expect(invoke).toHaveBeenCalledWith('sessions:open', {
      demandGeneration: 7,
      sourceRevision: 9,
      handle: liveRow.handle,
      projectId: liveRow.project.id,
      workspaceId: liveRow.workspace.id,
      workspaceQualifier: liveRow.workspace.qualifier,
      livePty: liveRow.livePty,
    })
    expect(onOpened).toHaveBeenCalledWith(openedResponse.state)
    expect(onFocusOpened).toHaveBeenCalledWith(
      liveRow.handle,
      liveRow.workspace.qualifier,
      liveRow.livePty,
    )
    expect(onSession).not.toHaveBeenCalled()
  })

  it('falls back to the Sessions destination with the exact row when the terminal is unavailable', async () => {
    const respond = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'sessions:open'
        ? Promise.resolve({ outcome: 'unavailable', reason: 'terminal-unavailable' })
        : respond(channel, request),
    )
    await render(projectionWith(liveRow))
    await interact(() => sessionButton().click())
    expect(onSession).toHaveBeenCalledWith(liveRow)
    expect(onOpened).not.toHaveBeenCalled()
    expect(onFocusOpened).not.toHaveBeenCalled()
    expect(sessionButton().disabled).toBe(false)
  })

  it('falls back to the Sessions destination when the open request throws', async () => {
    const respond = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'sessions:open'
        ? Promise.reject(new Error('ipc failed'))
        : respond(channel, request),
    )
    await render(projectionWith(liveRow))
    await interact(() => sessionButton().click())
    expect(onSession).toHaveBeenCalledWith(liveRow)
    expect(onError).toHaveBeenCalledWith('The exact terminal could not be opened')
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('reports an opened terminal that refuses focus', async () => {
    const respond = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'sessions:open'
        ? Promise.resolve(openedResponse)
        : respond(channel, request),
    )
    onFocusOpened.mockResolvedValueOnce(false)
    await render(projectionWith(liveRow))
    await interact(() => sessionButton().click())
    expect(onOpened).toHaveBeenCalledWith(openedResponse.state)
    expect(onError).toHaveBeenCalledWith(
      'The exact terminal changed before it could receive focus',
    )
    expect(onSession).not.toHaveBeenCalled()
  })

  it('does not navigate when the view is backgrounded before the open resolves', async () => {
    let resolveOpen!: (value: unknown) => void
    const respond = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'sessions:open'
        ? new Promise((resolve) => {
            resolveOpen = resolve
          })
        : respond(channel, request),
    )
    await render(projectionWith(liveRow))
    await interact(() => sessionButton().click())
    expect(sessionButton().textContent).toContain('Opening…')
    focused.mockReturnValue(false)
    await interact(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await interact(() => resolveOpen(openedResponse))
    expect(onOpened).not.toHaveBeenCalled()
    expect(onFocusOpened).not.toHaveBeenCalled()
    expect(onSession).not.toHaveBeenCalled()
  })
})
