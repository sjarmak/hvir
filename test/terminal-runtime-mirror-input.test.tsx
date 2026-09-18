// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import type { TerminalEvent, TerminalPane } from '../src/renderer/src/terminal/terminal-pane'
import { asHarnessProfileId, localPath, type StartPtyResponse } from '../src/shared'

const paneFactory = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/terminal/terminal-pane-factory', () => ({
  createTerminalRuntimePane: paneFactory,
}))

const SESSION_ID = 'terminal-mirrored'

type FakePane = TerminalPane & {
  readonly write: ReturnType<typeof vi.fn>
  emitEvent(event: TerminalEvent): void
}

function fakePane(): FakePane {
  const noopDisposer = () => undefined
  const eventHandlers: Array<(event: TerminalEvent) => void> = []
  return {
    emitEvent: (event: TerminalEvent) => {
      for (const handler of eventHandlers) handler(event)
    },
    mount: vi.fn(),
    reparent: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    setTypography: vi.fn(),
    setCursorDefaults: vi.fn(),
    setLigatures: vi.fn(),
    setPresentation: vi.fn(),
    redraw: vi.fn(),
    resolveEventProvenance: vi.fn(() => undefined),
    activeEventScreen: vi.fn(() => 'primary' as const),
    revealEventLocation: vi.fn(() => false),
    searchRetainedBuffer: vi.fn(() => Promise.reject(new Error('unsupported'))),
    cancelRetainedBufferSearch: vi.fn(),
    captureRetainedBufferBoundary: vi.fn(() => undefined),
    extractRetainedBufferRange: vi.fn(() => Promise.resolve('')),
    cancelRetainedBufferExtraction: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    events: {
      onData: vi.fn(() => noopDisposer),
      onClipboardPaste: vi.fn(() => noopDisposer),
      onEvent: vi.fn((handler: (event: TerminalEvent) => void) => {
        eventHandlers.push(handler)
        return noopDisposer
      }),
      onResize: vi.fn(() => noopDisposer),
      onLink: vi.fn(() => noopDisposer),
    },
  } as unknown as FakePane
}

function startResponse(): StartPtyResponse {
  return {
    outcome: 'started',
    id: SESSION_ID,
    instanceId: `${SESSION_ID}-instance`,
    pid: 42,
    resumed: false,
    reattached: false,
    identityStatus: 'none',
    capabilities: { sessionIdentity: 'none', exactResume: false, contextPresentation: 'none' },
  }
}

function options(): TerminalRuntimeOptions {
  return {
    sessionId: SESSION_ID,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    supportsResume: false,
    fallbackTitle: 'Shell · repo',
    resumeOnStart: false,
    startMode: 'interactive',
    position: 0,
    active: true,
    presentation: 'hidden',
    modifiedKeyProtocol: 'csi-u',
    metaEnterAliasesControl: false,
    composerSubmitMode: 'enter',
    theme: terminalThemeForAppearance('dark'),
    typography: { fontFamily: 'ui-monospace, monospace', fontSize: 13 },
    cursorDefaults: { shape: 'block', blink: 'terminal' },
    ligatures: true,
    cwd: localPath('/repo'),
    workspaceRoot: localPath('/repo'),
    connectionState: 'connected',
    onTitle: vi.fn(),
    onStatus: vi.fn(),
    onTelemetry: vi.fn(),
    onIdentity: vi.fn(),
    onStarted: vi.fn(),
    onFreshStarted: vi.fn(),
    onCapabilities: vi.fn(),
    onInput: vi.fn(),
    onMirrorInput: vi.fn(),
    onOutput: vi.fn(),
    onBell: vi.fn(),
    onNotification: vi.fn(),
    onFocus: vi.fn(),
    onLink: vi.fn(),
  }
}

function stubHvir(): {
  readonly send: ReturnType<typeof vi.fn>
  readonly invoke: ReturnType<typeof vi.fn>
  readonly emit: (channel: string, payload: unknown) => void
} {
  const send = vi.fn()
  const invoke = vi.fn(() => Promise.resolve(startResponse()))
  const handlers = new Map<string, (payload: unknown) => void>()
  vi.stubGlobal('window', {
    hvir: {
      invoke,
      send,
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        handlers.set(channel, handler)
        return () => handlers.delete(channel)
      }),
    },
  })
  return { send, invoke, emit: (channel, payload) => handlers.get(channel)?.(payload) }
}

describe('TerminalRuntime mirror input (ADR-050)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    paneFactory.mockReset()
  })

  it('mirror input reaches onMirrorInput, not onInput, and never pty:write', async () => {
    const pane = fakePane()
    paneFactory.mockResolvedValue(pane)
    const { send, invoke, emit } = stubHvir()
    const runtimeOptions = options()
    const runtime = new TerminalRuntimeRegistry().acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('pty:start', expect.anything()),
    )
    await vi.waitFor(() => expect(runtimeOptions.onStarted).toHaveBeenCalled())

    emit('pty:mirror-input', { id: SESSION_ID, data: "printf 'done'\r" })
    emit('pty:mirror-input', { id: 'another-session', data: '\r' })

    expect(runtimeOptions.onMirrorInput).toHaveBeenCalledExactlyOnceWith("printf 'done'\r")
    expect(runtimeOptions.onInput).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('pty:write', expect.anything())
    expect(pane.write.mock.calls).not.toContainEqual(["printf 'done'\r"])
    expect(runtimeOptions.onOutput).not.toHaveBeenCalled()
    runtime.dispose()
  })
})

describe('TerminalRuntime notification (ADR-051)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    paneFactory.mockReset()
  })

  it('hands a notification body to onNotification and keeps the bell for BEL', async () => {
    const pane = fakePane()
    paneFactory.mockResolvedValue(pane)
    const { invoke } = stubHvir()
    const runtimeOptions = options()
    const runtime = new TerminalRuntimeRegistry().acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('pty:start', expect.anything()),
    )
    await vi.waitFor(() => expect(runtimeOptions.onStarted).toHaveBeenCalled())

    pane.emitEvent({
      type: 'notification',
      source: 'osc-9',
      title: '',
      body: 'Claude needs your permission',
    })
    pane.emitEvent({ type: 'notification', source: 'osc-777', title: 'Done', body: '' })
    pane.emitEvent({ type: 'bell' })

    expect(runtimeOptions.onNotification).toHaveBeenNthCalledWith(
      1,
      'Claude needs your permission',
    )
    expect(runtimeOptions.onNotification).toHaveBeenNthCalledWith(2, undefined)
    expect(runtimeOptions.onBell).toHaveBeenCalledOnce()
    expect(runtimeOptions.onInput).not.toHaveBeenCalled()
    runtime.dispose()
  })
})
