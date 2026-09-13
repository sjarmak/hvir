// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  initialTerminalWorkspaceModel,
  type TerminalAttachRequest,
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
