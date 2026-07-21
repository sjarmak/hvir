import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TerminalRuntimeRegistry,
  type TerminalRuntimeOptions,
} from '../src/renderer/src/terminal/terminal-runtime'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'
import {
  asHarnessProfileId,
  localPath,
  type HostConnectionState,
  type HostPath,
  type StartPtyResponse,
} from '../src/shared'

const paneFactory = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/terminal/ghostty-terminal-pane', () => ({
  createGhosttyTerminalPane: paneFactory,
}))

function fakePane(): TerminalPane {
  const noopDisposer = () => undefined
  return {
    mount: vi.fn(),
    reparent: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    redraw: vi.fn(),
    focus: vi.fn(),
    events: {
      onData: vi.fn(() => noopDisposer),
      onTitle: vi.fn(() => noopDisposer),
      onBell: vi.fn(() => noopDisposer),
      onOsc: vi.fn(() => noopDisposer),
      onResize: vi.fn(() => noopDisposer),
      onLink: vi.fn(() => noopDisposer),
    },
  }
}

function startResponse(): StartPtyResponse {
  return {
    id: 'terminal-1',
    pid: 42,
    resumed: false,
    identityStatus: 'none',
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
  }
}

function options(
  workspaceRoot: HostPath,
  connectionState: HostConnectionState = 'connected',
): TerminalRuntimeOptions {
  return {
    sessionId: 'terminal-1',
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    riskAcknowledged: false,
    supportsResume: true,
    fallbackTitle: 'Codex · repo',
    harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
    resumeOnStart: false,
    position: 0,
    active: true,
    modifiedKeyProtocol: 'csi-u',
    metaEnterAliasesControl: false,
    composerSubmitMode: 'enter',
    cwd: localPath('/repo'),
    workspaceRoot,
    connectionState,
    onTitle: vi.fn(),
    onStatus: vi.fn(),
    onTelemetry: vi.fn(),
    onIdentity: vi.fn(),
    onStarted: vi.fn(),
    onCapabilities: vi.fn(),
    onInput: vi.fn(),
    onOutput: vi.fn(),
    onBell: vi.fn(),
    onFocus: vi.fn(),
    onLink: vi.fn(),
  }
}

describe('TerminalRuntimeRegistry', () => {
  it('retains one live runtime while its workspace presentation changes', () => {
    const registry = new TerminalRuntimeRegistry()
    const source = options(localPath('/repo'))
    const first = registry.acquire(source)
    const target = options(localPath('/repo-feature'))
    const moved = registry.acquire(target)

    expect(moved).toBe(first)
    expect(moved.workspaceRoot).toEqual(target.workspaceRoot)
    expect(() => moved.update({ ...target, cwd: localPath('/repo-feature') })).toThrow(
      'launch context cannot change',
    )
    registry.dispose()
  })

  it('publishes an initial disconnected host state before a pane mounts', () => {
    const runtimeOptions = options(localPath('/repo'), 'disconnected')
    const runtime = new TerminalRuntimeRegistry().acquire(runtimeOptions)

    runtime.synchronizeConnection()

    expect(runtime.snapshot()).toMatchObject({
      title: 'Codex · repo',
      status: 'disconnected',
      exited: false,
    })
    expect(runtimeOptions.onStatus).toHaveBeenCalledWith('disconnected')
    expect(runtimeOptions.onTelemetry).toHaveBeenCalledWith(undefined)
  })
})

describe('TerminalRuntime initial input', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    paneFactory.mockReset()
  })

  function stubHvir(): { send: ReturnType<typeof vi.fn> } {
    const send = vi.fn()
    vi.stubGlobal('window', {
      hvir: {
        invoke: vi.fn(async () => startResponse()),
        send,
        on: vi.fn(() => () => undefined),
      },
    })
    return { send }
  }

  function ptyWrites(send: ReturnType<typeof vi.fn>): unknown[] {
    return send.mock.calls
      .filter(([channel]) => channel === 'pty:write')
      .map(([, payload]) => payload)
  }

  it('types the initial command once, after first launch', async () => {
    paneFactory.mockResolvedValue(fakePane())
    const { send } = stubHvir()
    const runtime = new TerminalRuntimeRegistry().acquire({
      ...options(localPath('/repo')),
      initialInput: 'gc session attach worker',
    })

    runtime.attach({} as unknown as HTMLElement)

    await vi.waitFor(() =>
      expect(ptyWrites(send)).toEqual([
        { id: 'terminal-1', data: 'gc session attach worker\r' },
      ]),
    )
  })

  it('does not replay the initial command on a manual restart', async () => {
    paneFactory.mockResolvedValue(fakePane())
    const { send } = stubHvir()
    const runtime = new TerminalRuntimeRegistry().acquire({
      ...options(localPath('/repo')),
      initialInput: 'gc session attach worker',
    })

    runtime.attach({} as unknown as HTMLElement)
    await vi.waitFor(() => expect(ptyWrites(send)).toHaveLength(1))

    paneFactory.mockResolvedValue(fakePane())
    runtime.restart()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('pty:kill', { id: 'terminal-1' }),
    )

    expect(ptyWrites(send)).toHaveLength(1)
  })

  it('never types a command when no initial input is set', async () => {
    paneFactory.mockResolvedValue(fakePane())
    const { send } = stubHvir()
    const runtime = new TerminalRuntimeRegistry().acquire(options(localPath('/repo')))

    runtime.attach({} as unknown as HTMLElement)
    await vi.waitFor(() =>
      expect(window.hvir.invoke).toHaveBeenCalledWith('pty:start', expect.anything()),
    )

    expect(ptyWrites(send)).toHaveLength(0)
  })
})
