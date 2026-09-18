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
  working: readonly string[] = [],
): WorkspaceAttentionRollup => ({
  actionable: entries.length,
  working: working.length,
  entries,
  workingHandles: working.map(asSessionsTerminalHandle),
})

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
  it('sends the working terminals beside the entries, and an entry outranks working', () => {
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenLastCalledWith('app:attention', EMPTY_RENDERER_ATTENTION_SET)

    act(() => attention.updateRollup('ws-a', rollup([], ['t1'])))
    expect(host.textContent).toContain('"working":1')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('app:attention', {
      version: 1,
      entries: [],
      working: ['t1'],
    })

    // The same working terminal again, in a fresh array, is not a change.
    act(() => attention.updateRollup('ws-a', rollup([], ['t1'])))
    expect(send).toHaveBeenCalledTimes(2)

    // Another workspace claims t1 as an entry: it leaves working and joins the entries.
    act(() => attention.updateRollup('ws-b', rollup([entry('t1')], ['t2'])))
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith('app:attention', {
      version: 1,
      entries: [entry('t1')],
      working: ['t2'],
    })
  })

  it('sends the entries of every workspace, once per change of the set', () => {
    act(() => attention.updateRollup('ws-a', rollup([entry('t1')])))
    act(() => attention.updateRollup('ws-b', rollup([entry('t2', 'bell')])))
    expect(sent().at(-1)).toEqual({
      version: 1,
      entries: [entry('t1'), entry('t2', 'bell')],
      working: [],
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
      working: [],
    })

    act(() => attention.updateRollup('ws-b', rollup([])))
    expect(sent().at(-1)).toEqual({
      version: 1,
      entries: [entry('t1', 'bell')],
      working: [],
    })
  })

  it('sends a prompt again when only its body changed (ADR-051)', () => {
    const prompt = (body: string): ActionableAttentionEntry => ({
      ...entry('t1', 'prompt'),
      body,
    })
    act(() => attention.updateRollup('ws-a', rollup([prompt('first')])))
    expect(send).toHaveBeenCalledTimes(2)
    act(() => attention.updateRollup('ws-a', rollup([prompt('first')])))
    expect(send).toHaveBeenCalledTimes(2)
    act(() => attention.updateRollup('ws-a', rollup([prompt('second')])))
    expect(send).toHaveBeenCalledTimes(3)
    expect(sent().at(-1)).toEqual({
      version: 1,
      entries: [prompt('second')],
      working: [],
    })
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
