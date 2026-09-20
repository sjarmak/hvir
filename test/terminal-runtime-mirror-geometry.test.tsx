// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import type {
  TerminalPane,
  TerminalSize,
} from '../src/renderer/src/terminal/terminal-pane'
import { asHarnessProfileId, localPath, type StartPtyResponse } from '../src/shared'

const paneFactory = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/terminal/terminal-pane-factory', () => ({
  createTerminalRuntimePane: paneFactory,
}))

const SESSION_ID = 'terminal-held'
/** Past the runtime's pty:resize debounce (75 ms). */
const DEBOUNCE_ELAPSED_MS = 120

function fakePane() {
  const noopDisposer = () => undefined
  const resizeHandlers: Array<(size: TerminalSize) => void> = []
  const heldGeometry = vi.fn<TerminalPane['setHeldGeometry']>()
  const pane: TerminalPane = {
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
    setHeldGeometry: heldGeometry,
    redraw: vi.fn(),
    resolveEventProvenance: vi.fn(() => undefined),
    activeEventScreen: vi.fn(() => 'normal' as const),
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
    reset: vi.fn(),
    focus: vi.fn(),
    events: {
      onData: vi.fn(() => noopDisposer),
      onClipboardPaste: vi.fn(() => noopDisposer),
      onEvent: vi.fn(() => noopDisposer),
      onResize: vi.fn((handler: (size: TerminalSize) => void) => {
        resizeHandlers.push(handler)
        return noopDisposer
      }),
      onLink: vi.fn(() => noopDisposer),
    },
  }
  return {
    pane,
    heldGeometry,
    /** The engine reporting its grid size, as ghostty does after any resize. */
    fireResize: (size: TerminalSize) => {
      for (const handler of resizeHandlers) handler(size)
    },
  }
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
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
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
    presentation: 'visible',
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
    setTimeout: (callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle: number | undefined) => globalThis.clearTimeout(handle),
  })
  return { send, invoke, emit: (channel, payload) => handlers.get(channel)?.(payload) }
}

function ptyResizes(send: ReturnType<typeof vi.fn>): unknown[] {
  return send.mock.calls
    .filter(([channel]) => channel === 'pty:resize')
    .map(([, payload]) => payload as unknown)
}

function elapseDebounce(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, DEBOUNCE_ELAPSED_MS))
}

async function startedRuntime() {
  const { pane, heldGeometry, fireResize } = fakePane()
  paneFactory.mockResolvedValue(pane)
  const hvir = stubHvir()
  const runtimeOptions = options()
  const runtime = new TerminalRuntimeRegistry().acquire(runtimeOptions)
  runtime.attach(document.createElement('div'))
  await vi.waitFor(() =>
    expect(hvir.invoke).toHaveBeenCalledWith('pty:start', expect.anything()),
  )
  await vi.waitFor(() => expect(runtimeOptions.onStarted).toHaveBeenCalled())
  return { heldGeometry, fireResize, runtime, ...hvir }
}

describe('TerminalRuntime mirror geometry (ADR-058)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    paneFactory.mockReset()
  })

  it('presents a held size and silences its own pty:resize until the desktop reclaims', async () => {
    const { heldGeometry, fireResize, runtime, send, emit } = await startedRuntime()

    fireResize({ cols: 100, rows: 25 })
    await elapseDebounce()
    expect(ptyResizes(send)).toEqual([{ id: SESSION_ID, cols: 100, rows: 25 }])

    emit('pty:mirror-geometry', { id: SESSION_ID, kind: 'held', cols: 61, rows: 23 })
    expect(heldGeometry).toHaveBeenCalledExactlyOnceWith({ cols: 61, rows: 23 })

    // The engine echoes the held grid, then a late measurement arrives: neither reaches the PTY.
    fireResize({ cols: 61, rows: 23 })
    fireResize({ cols: 100, rows: 25 })
    await elapseDebounce()
    expect(ptyResizes(send)).toHaveLength(1)

    emit('pty:mirror-geometry', { id: SESSION_ID, kind: 'reclaim' })
    expect(heldGeometry).toHaveBeenLastCalledWith(undefined)
    expect(ptyResizes(send)).toHaveLength(1)

    // The resumed fit re-measures the pane; exactly one resize re-asserts its own size.
    fireResize({ cols: 100, rows: 25 })
    await elapseDebounce()
    expect(ptyResizes(send)).toEqual([
      { id: SESSION_ID, cols: 100, rows: 25 },
      { id: SESSION_ID, cols: 100, rows: 25 },
    ])
    runtime.dispose()
  })

  it('a resize already debouncing when the hold arrives never sends', async () => {
    const { fireResize, runtime, send, emit } = await startedRuntime()

    fireResize({ cols: 100, rows: 25 })
    emit('pty:mirror-geometry', { id: SESSION_ID, kind: 'held', cols: 61, rows: 23 })
    await elapseDebounce()

    expect(ptyResizes(send)).toEqual([])
    runtime.dispose()
  })

  it('ignores geometry addressed to another PTY', async () => {
    const { heldGeometry, runtime, emit } = await startedRuntime()

    emit('pty:mirror-geometry', {
      id: 'another-session',
      kind: 'held',
      cols: 61,
      rows: 23,
    })
    emit('pty:mirror-geometry', { id: 'another-session', kind: 'reclaim' })

    expect(heldGeometry).not.toHaveBeenCalled()
    runtime.dispose()
  })
})
