// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useTerminalAttention } from '../src/renderer/src/terminal/use-terminal-attention'
import type { WorkspaceAttentionRollup } from '../src/renderer/src/workspaces/project-session-model'
import {
  EMPTY_RENDERER_ATTENTION_SET,
  asSessionsTerminalHandle,
  type ActionableAttentionEntry,
} from '../src/shared'

let host: HTMLDivElement
let root: Root
let attention: ReturnType<typeof useTerminalAttention>
let send: Mock<(channel: string, payload: unknown) => void>

const entry = (
  handle: string,
  kind: ActionableAttentionEntry['kind'] = 'ready',
): ActionableAttentionEntry => ({
  handle: asSessionsTerminalHandle(handle),
  kind,
  freshness: 'fresh',
})

const rollup = (
  entries: readonly ActionableAttentionEntry[],
  working = 0,
): WorkspaceAttentionRollup => ({ actionable: entries.length, working, entries })

const sent = (): unknown[] => send.mock.calls.map(([, set]) => set)

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  send = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { send },
  })
  act(() => root.render(<TerminalAttentionProbe />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('terminal attention rollup bridge', () => {
  it('updates Working presentation without sending non-actionable OS attention', () => {
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenLastCalledWith('app:attention', EMPTY_RENDERER_ATTENTION_SET)

    act(() => attention.updateRollup('workspace:local:/repo', rollup([], 1)))
    expect(host.textContent).toContain('"working":1')
    expect(send).toHaveBeenCalledOnce()

    act(() => attention.updateRollup('workspace:local:/repo', rollup([], 2)))
    expect(host.textContent).toContain('"working":2')
    expect(send).toHaveBeenCalledOnce()

    act(() => attention.updateRollup('workspace:local:/repo', rollup([entry('t1')], 2)))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('app:attention', {
      version: 1,
      entries: [entry('t1')],
    })
  })

  it('sends the entries of every workspace, once per change of the set', () => {
    act(() => attention.updateRollup('ws-a', rollup([entry('t1')])))
    act(() => attention.updateRollup('ws-b', rollup([entry('t2', 'bell')])))
    expect(sent().at(-1)).toEqual({
      version: 1,
      entries: [entry('t1'), entry('t2', 'bell')],
    })
    expect(send).toHaveBeenCalledTimes(3)

    // The same set again, in a fresh array, is not a change.
    act(() => attention.updateRollup('ws-a', rollup([entry('t1')])))
    expect(send).toHaveBeenCalledTimes(3)

    // The count is unchanged but the kind is: the set says what is waiting, not how many.
    act(() => attention.updateRollup('ws-a', rollup([entry('t1', 'bell')])))
    expect(send).toHaveBeenCalledTimes(4)
    expect(sent().at(-1)).toEqual({
      version: 1,
      entries: [entry('t1', 'bell'), entry('t2', 'bell')],
    })

    act(() => attention.updateRollup('ws-b', rollup([])))
    expect(sent().at(-1)).toEqual({ version: 1, entries: [entry('t1', 'bell')] })
  })

  it('withdraws everything on unmount', () => {
    act(() => attention.updateRollup('ws-a', rollup([entry('t1')])))
    act(() => root.unmount())
    expect(send).toHaveBeenLastCalledWith('app:attention', EMPTY_RENDERER_ATTENTION_SET)
    root = createRoot(host)
  })
})

function TerminalAttentionProbe() {
  attention = useTerminalAttention()
  return <output>{JSON.stringify(attention.rollups)}</output>
}
