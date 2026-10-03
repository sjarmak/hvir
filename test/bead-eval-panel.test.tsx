// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BeadsPanel } from '../src/renderer/src/beads/BeadsPanel'
import { asHostId, hostPath, type BeadsListResponse } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/synthetic/eval-fixture')
const RESPONSE: BeadsListResponse = {
  available: true,
  issues: [
    {
      id: 'eval-1',
      title: 'Synthetic eval result',
      status: 'open',
      priority: 2,
      issueType: 'task',
      labels: [],
      dependencyCount: 0,
      dependentCount: 0,
      metadata: {
        'eval.run_url': 'https://eval.example/runs/synthetic-1',
        'eval.run_id': 'synthetic-1',
        'eval.candidate_sha': '0123456789abcdef0123456789abcdef01234567',
      },
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

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const invoke = vi.fn((channel: string) => {
    if (channel === 'beads:list') return Promise.resolve(RESPONSE)
    if (channel === 'gascity:probe') return Promise.resolve({ hasCity: false })
    if (channel === 'gascity:crew') return Promise.resolve({ available: false })
    return Promise.resolve(undefined)
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

describe('BeadsPanel evaluation detail', () => {
  it('reveals exact producer metadata when a bead row is expanded', async () => {
    act(() => {
      root.render(
        createElement(BeadsPanel, {
          root: ROOT,
          connected: true,
        }),
      )
    })
    for (let hop = 0; hop < 4; hop += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }

    const row = host.querySelector<HTMLButtonElement>('[data-bead-id="eval-1"] .beads-row')
    expect(row).not.toBeNull()
    act(() => row?.click())

    const link = host.querySelector<HTMLAnchorElement>('[aria-label="Evaluation result"] a')
    expect(link?.href).toBe('https://eval.example/runs/synthetic-1')
    expect(host.textContent).toContain('Producer-supplied. Current result not verified.')
    expect(host.textContent).toContain('0123456789abcdef0123456789abcdef01234567')
  })
})
