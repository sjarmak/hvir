// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BeadsPanel } from '../src/renderer/src/beads/BeadsPanel'
import type { BeadActionRequest } from '../src/renderer/src/beads/bead-commands'
import { asHostId, hostPath, type BeadsListResponse } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/home/dev/city/rigs/mem')

const BEADS: BeadsListResponse = {
  available: true,
  issues: [
    {
      id: 'mem-1',
      title: 'Wire it',
      status: 'open',
      priority: 2,
      issueType: 'task',
      labels: [],
      dependencyCount: 0,
      dependentCount: 0,
    },
  ],
  readyIds: [],
  dispatchableIds: [],
  dispatchabilitySource: 'structural',
  dependencies: [],
  gates: [],
}

let host: HTMLDivElement
let root: Root
let listCalls: number
let listFails: boolean

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  listCalls = 0
  listFails = false
  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'beads:list':
        listCalls += 1
        return listFails ? Promise.reject(new Error('bd timed out')) : Promise.resolve(BEADS)
      case 'gascity:probe':
        return Promise.resolve({ hasCity: false })
      default:
        return Promise.resolve(undefined)
    }
  })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.hvir = {
    invoke,
    on: () => () => undefined,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  for (let hop = 0; hop < 4; hop += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function renderPanel(onBeadAction: (request: BeadActionRequest) => void): Promise<void> {
  act(() => {
    root.render(createElement(BeadsPanel, { root: ROOT, connected: true, onBeadAction }))
  })
  await flush()
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}

function input(): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>('input[aria-label="New bead title"]')
  if (!element) throw new Error('create input not rendered')
  return element
}

function type(value: string): void {
  act(() => {
    const element = input()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value,
    )
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('BeadsPanel bead actions', () => {
  it('schedules exactly one refresh shortly after a typed action', async () => {
    const onBeadAction = vi.fn()
    await renderPanel(onBeadAction)
    expect(listCalls).toBe(1)

    act(() => {
      host.querySelector<HTMLButtonElement>('.beads-row')?.click()
    })
    const claim = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Claim',
    )
    expect(claim).toBeDefined()
    act(() => {
      claim?.click()
    })
    expect(onBeadAction).toHaveBeenCalledWith({ action: 'claim', id: 'mem-1' })

    await advance(1400)
    expect(listCalls).toBe(1)
    await advance(200)
    expect(listCalls).toBe(2)
    await advance(1500)
    expect(listCalls).toBe(2)
  })

  it('keeps a half-typed create title across a failed refresh', async () => {
    await renderPanel(vi.fn())
    type('Draft title')
    expect(input().value).toBe('Draft title')

    listFails = true
    await advance(5000)
    expect(host.textContent).toContain('Beads unavailable')
    expect(host.querySelector('input[aria-label="New bead title"]')).toBeNull()

    listFails = false
    await advance(5000)
    expect(input().value).toBe('Draft title')
  })
})
