// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  initialTerminalWorkspaceModel,
  type TerminalAttachRequest,
  type TerminalWorkspaceModel,
} from '../src/renderer/src/terminal/terminal-workspace-model'
import {
  useTerminalAttachRequest,
  type TerminalAttachPorts,
} from '../src/renderer/src/terminal/use-terminal-attach-request'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Probe({
  request,
  ports,
}: {
  readonly request?: TerminalAttachRequest
  readonly ports: TerminalAttachPorts
}): ReactElement {
  useTerminalAttachRequest(request, ports)
  return createElement('div')
}

function ports(overrides: Partial<TerminalAttachPorts> = {}): TerminalAttachPorts {
  return {
    currentModel: () => initialTerminalWorkspaceModel,
    focusSession: vi.fn(),
    launch: vi.fn(() => 'session-1'),
    resolveAttached: vi.fn(() => Promise.resolve([])),
    canLaunch: true,
    ...overrides,
  }
}

function render(
  request: TerminalAttachRequest | undefined,
  p: TerminalAttachPorts,
): void {
  act(() => {
    root.render(createElement(Probe, { request, ports: p }))
  })
}

async function renderAttach(
  request: TerminalAttachRequest,
  p: TerminalAttachPorts,
): Promise<void> {
  // A request naming a session waits on main, so the effect settles a tick
  // late: returning a promise puts act in the mode that flushes it.
  await act(() => Promise.resolve(root.render(createElement(Probe, { request, ports: p }))))
}

function modelWith(...ids: readonly string[]): () => TerminalWorkspaceModel {
  const sessions = ids.map((id) => ({ id }) as TerminalWorkspaceModel['sessions'][number])
  return () => ({ ...initialTerminalWorkspaceModel, sessions })
}

describe('useTerminalAttachRequest', () => {
  it('settles a request as accepted once the shell launched', () => {
    const onSettled = vi.fn()
    render({ command: 'bd close x', nonce: 1, onSettled }, ports())
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('settles a request as rejected when the workspace cannot launch', () => {
    const onSettled = vi.fn()
    render(
      { command: 'bd close x', nonce: 1, onSettled },
      ports({ launch: vi.fn(() => undefined), canLaunch: false }),
    )
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('settles a keyed re-request as accepted when it focuses the live terminal', () => {
    const focusSession = vi.fn()
    const model = initialTerminalWorkspaceModel
    const p = ports({
      focusSession,
      currentModel: () => ({
        ...model,
        sessions: [{ id: 'session-1' } as (typeof model.sessions)[number]],
      }),
    })
    const first = vi.fn()
    render({ command: 'gc session attach m', nonce: 1, key: 'gc:m', onSettled: first }, p)
    expect(first).toHaveBeenCalledExactlyOnceWith(true)
    const second = vi.fn()
    render(
      { command: 'gc session attach m', nonce: 2, key: 'gc:m', onSettled: second },
      p,
    )
    expect(focusSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(second).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('focuses the terminal main recorded for the session, with no memory of it', async () => {
    // What a fresh renderer knows after a reload: nothing. Main holds the join.
    const focusSession = vi.fn()
    const launch = vi.fn(() => 'session-2')
    const onSettled = vi.fn()
    await renderAttach(
      {
        command: 'gc session attach m',
        nonce: 1,
        key: 'gc:m',
        attaches: { sourceId: 'gas-city', key: 'gc-worker-7' },
        onSettled,
      },
      ports({
        focusSession,
        launch,
        currentModel: modelWith('session-9'),
        resolveAttached: vi.fn(() => Promise.resolve(['session-9'])),
      }),
    )
    expect(focusSession).toHaveBeenCalledExactlyOnceWith('session-9')
    expect(launch).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('launches with the attach target, so main can record the join', async () => {
    const attaches = { sourceId: 'gas-city', key: 'gc-worker-7' } as const
    const launch = vi.fn(() => 'session-2')
    const resolveAttached = vi.fn(() => Promise.resolve([]))
    await renderAttach(
      { command: 'gc session attach m', nonce: 1, key: 'gc:m', attaches },
      ports({ launch, resolveAttached }),
    )
    expect(resolveAttached).toHaveBeenCalledExactlyOnceWith(attaches)
    expect(launch).toHaveBeenCalledExactlyOnceWith('gc session attach m', attaches)
  })

  it('launches when main names a terminal this workspace no longer has', async () => {
    const focusSession = vi.fn()
    const launch = vi.fn(() => 'session-2')
    await renderAttach(
      {
        command: 'gc session attach m',
        nonce: 1,
        attaches: { sourceId: 'gas-city', key: 'gc-worker-7' },
      },
      ports({
        focusSession,
        launch,
        resolveAttached: vi.fn(() => Promise.resolve(['closed-session'])),
      }),
    )
    expect(focusSession).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('still launches when main cannot say what is attached', async () => {
    const launch = vi.fn(() => 'session-2')
    const onSettled = vi.fn()
    await renderAttach(
      {
        command: 'gc session attach m',
        nonce: 1,
        attaches: { sourceId: 'gas-city', key: 'gc-worker-7' },
        onSettled,
      },
      ports({
        launch,
        resolveAttached: vi.fn(() => Promise.reject(new Error('no channel'))),
      }),
    )
    expect(launch).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('reports launch availability when it changes, not on every render', () => {
    const reportAvailability = vi.fn()
    render(undefined, ports({ canLaunch: false, reportAvailability }))
    expect(reportAvailability).toHaveBeenCalledExactlyOnceWith(false)
    render(undefined, ports({ canLaunch: false, reportAvailability }))
    expect(reportAvailability).toHaveBeenCalledTimes(1)
    render(undefined, ports({ canLaunch: true, reportAvailability }))
    expect(reportAvailability).toHaveBeenLastCalledWith(true)
    expect(reportAvailability).toHaveBeenCalledTimes(2)
  })
})
