// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useTerminalAttentionController,
  useTerminalAttentionRollup,
  type TerminalAttentionRollup,
} from '../src/renderer/src/terminal/use-terminal-attention-controller'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'

let controller: ReturnType<typeof useTerminalAttentionController> | undefined
let host: HTMLDivElement
let root: Root
let session: TerminalSession

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  session = terminalSession()
  act(() => {
    root.render(
      <AttentionControllerProbe
        onUpdateSession={(id, update) => {
          if (id === session.id) session = update(session)
        }}
      />,
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  controller = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal attention controller', () => {
  it('advances unfocused submitted-turn output from working to ready at the threshold', () => {
    act(() => {
      controller?.recordInput(session.id, '\r')
      controller?.recordOutput(session.id)
    })
    expect(session.attention).toBe('working')

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(session.attention).toBe('working')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(session.attention).toBe('idle')
  })

  it('recordInput from a mirror Enter arms exactly like a desktop Enter', () => {
    // The phone sends the line and its Enter as one write (ADR-050); the
    // renderer records it through the same door a keyboard Enter uses.
    act(() => {
      controller?.recordInput(session.id, "printf 'mirror-done'\r")
      controller?.recordOutput(session.id)
    })
    expect(session.attention).toBe('working')

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(session.attention).toBe('idle')
  })

  it('recordInput without newline never clears attention', () => {
    act(() => {
      controller?.recordInput(session.id, '\r')
      controller?.recordOutput(session.id)
      vi.advanceTimersByTime(1_000)
    })
    expect(session.attention).toBe('idle')

    // Arrow keys, a bare answer, and a fresh line from the phone: none clears.
    for (const data of ['[A', 'y', 'y\r']) {
      act(() => {
        controller?.recordInput(session.id, data)
        controller?.recordOutput(session.id)
        vi.advanceTimersByTime(1_000)
      })
      expect(session.attention, JSON.stringify(data)).toBe('idle')
    }
  })

  it('raises a prompt with its body at once, with no Enter and no quiet period', () => {
    act(() => {
      controller?.raiseAttention(session.id, 'prompt', 'Claude needs your permission')
    })
    expect(session.attention).toBe('prompt')
    expect(session.promptBody).toBe('Claude needs your permission')

    // Output resuming never clears it, and Ready cannot displace it.
    act(() => {
      controller?.recordInput(session.id, '\r')
      controller?.recordOutput(session.id)
      vi.advanceTimersByTime(1_000)
    })
    expect(session.attention).toBe('prompt')
    expect(session.promptBody).toBe('Claude needs your permission')

    act(() => {
      controller?.raiseAttention(session.id, 'bell')
      controller?.raiseAttention(session.id, 'prompt', 'Claude is waiting for your input')
    })
    expect(session.attention).toBe('prompt')
    expect(session.promptBody).toBe('Claude is waiting for your input')
  })

  it('clears only a prompt on mirror input, and still arms Ready like a desktop Enter', () => {
    act(() => {
      controller?.raiseAttention(session.id, 'prompt', 'Claude needs your permission')
      controller?.recordMirrorInput(session.id, 'y')
    })
    expect(session.attention).toBeUndefined()
    expect(session.promptBody).toBeUndefined()

    act(() => {
      controller?.recordMirrorInput(session.id, '\r')
      controller?.recordOutput(session.id)
      vi.advanceTimersByTime(1_000)
    })
    expect(session.attention).toBe('idle')

    act(() => {
      controller?.recordMirrorInput(session.id, 'more\r')
    })
    expect(session.attention).toBe('idle')

    act(() => {
      controller?.raiseAttention(session.id, 'bell')
      controller?.recordMirrorInput(session.id, '\r')
    })
    expect(session.attention).toBe('idle')
    session = { ...session, attention: 'bell' }
    act(() => {
      controller?.recordMirrorInput(session.id, '\r')
    })
    expect(session.attention).toBe('bell')
  })

  it('publishes Working separately from actionable attention and clears both on cleanup', () => {
    const onRollup = vi.fn()
    const sessions = [
      { ...terminalSession(), attention: 'working' as const },
      { ...terminalSession(), id: 'terminal-2', attention: 'idle' as const },
      { ...terminalSession(), id: 'terminal-3', attention: 'bell' as const },
      {
        ...terminalSession(),
        id: 'terminal-4',
        attention: 'prompt' as const,
        promptBody: 'Claude needs your permission',
      },
    ]

    act(() => {
      root.render(
        <AttentionRollupProbe
          workspaceId="workspace:local:/repo"
          sessions={sessions}
          onRollup={onRollup}
        />,
      )
    })
    expect(onRollup).toHaveBeenLastCalledWith('workspace:local:/repo', {
      actionable: 3,
      working: 1,
      entries: [
        { handle: 'terminal-2', kind: 'ready', freshness: 'fresh' },
        { handle: 'terminal-3', kind: 'bell', freshness: 'fresh' },
        {
          handle: 'terminal-4',
          kind: 'prompt',
          freshness: 'fresh',
          body: 'Claude needs your permission',
        },
      ],
    })

    act(() => root.render(<></>))
    expect(onRollup).toHaveBeenLastCalledWith('workspace:local:/repo', {
      actionable: 0,
      working: 0,
      entries: [],
    })
  })

  it('republishes the rollup only when a counted signal or an entry changes', () => {
    const onRollup = vi.fn()
    const render = (sessions: readonly TerminalSession[]) =>
      act(() =>
        root.render(
          <AttentionRollupProbe
            workspaceId="workspace:local:/repo"
            sessions={sessions}
            onRollup={onRollup}
          />,
        ),
      )
    render([{ ...terminalSession(), attention: 'idle' }])
    expect(onRollup).toHaveBeenCalledOnce()

    // A new array with the same signals is the same rollup.
    render([{ ...terminalSession(), attention: 'idle' }])
    expect(onRollup).toHaveBeenCalledOnce()

    // The count stays at one, but it is now a different kind of attention.
    render([{ ...terminalSession(), attention: 'bell' }])
    expect(onRollup).toHaveBeenCalledTimes(2)
    expect(onRollup).toHaveBeenLastCalledWith('workspace:local:/repo', {
      actionable: 1,
      working: 0,
      entries: [{ handle: 'terminal-1', kind: 'bell', freshness: 'fresh' }],
    })

    // The same prompt with a new message is a new entry (ADR-051).
    render([{ ...terminalSession(), attention: 'prompt', promptBody: 'first' }])
    render([{ ...terminalSession(), attention: 'prompt', promptBody: 'second' }])
    expect(onRollup).toHaveBeenCalledTimes(4)
    expect(onRollup).toHaveBeenLastCalledWith('workspace:local:/repo', {
      actionable: 1,
      working: 0,
      entries: [{ handle: 'terminal-1', kind: 'prompt', freshness: 'fresh', body: 'second' }],
    })
  })
})

function AttentionControllerProbe({
  onUpdateSession,
}: {
  readonly onUpdateSession: Parameters<
    typeof useTerminalAttentionController
  >[0]['onUpdateSession']
}) {
  controller = useTerminalAttentionController({
    idleThresholdMs: 1_000,
    onUpdateSession,
  })
  return null
}

function AttentionRollupProbe({
  workspaceId,
  sessions,
  onRollup,
}: {
  readonly workspaceId: string
  readonly sessions: readonly TerminalSession[]
  readonly onRollup: (workspaceId: string, rollup: TerminalAttentionRollup) => void
}) {
  useTerminalAttentionRollup({ workspaceId, sessions, onRollup })
  return null
}

function terminalSession(): TerminalSession {
  return {
    id: 'terminal-1',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    capabilities: {
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'none',
    },
    fallbackTitle: 'Codex · repo',
    title: 'Codex · repo',
    status: 'pid 73',
    resumeOnStart: false,
    pane: 'primary',
    cwd: localPath('/repo'),
  }
}
