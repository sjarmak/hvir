// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BeadsPanel } from '../src/renderer/src/beads/BeadsPanel'
import {
  asHostId,
  hostPath,
  type BeadsListResponse,
  type GasCityCrewResponse,
} from '../src/shared'

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
      assignee: 'mem-worker-ash',
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

const CREW: GasCityCrewResponse = {
  available: true,
  members: [
    {
      key: 'gc-1',
      tier: 'worker',
      label: 'mem-worker-ash',
      target: 'mem-worker-ash',
      identityKeys: ['gc-1', 'mem-worker-ash'],
      poolName: 'mem-worker',
      session: { id: 'gc-1', name: 'mem-worker-ash', state: 'active' },
    },
  ],
  tierSource: 'config',
  scope: 'rig',
  rigName: 'mem',
  diagnostics: { namedSessions: 1, pinned: 0, unmatched: [] },
}

let host: HTMLDivElement
let root: Root
let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true
  vi.useFakeTimers()
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as () => void
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'beads:list':
        return Promise.resolve(BEADS)
      case 'gascity:probe':
        return Promise.resolve({ hasCity: true })
      case 'gascity:crew':
        return Promise.resolve(CREW)
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

async function renderPanel(): Promise<void> {
  act(() => {
    root.render(
      createElement(BeadsPanel, { root: ROOT, connected: true, onCrewAction: () => undefined }),
    )
  })
  // The probe answers, then the crew fetch, then the bead list: three promise
  // hops before the join has both sides.
  for (let hop = 0; hop < 4; hop += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('BeadsPanel held-bead focus', () => {
  it('clicking a held bead on a crew card expands and scrolls its bead row', async () => {
    await renderPanel()
    const row = host.querySelector('[data-bead-id="mem-1"]')
    expect(row).not.toBeNull()
    const button = host.querySelector<HTMLButtonElement>('.crew-held-bead')
    expect(button?.textContent).toContain('mem-1')
    expect(row?.querySelector('.beads-row')?.classList.contains('expanded')).toBe(false)

    act(() => {
      button?.click()
    })

    expect(row?.querySelector('.beads-row')?.classList.contains('expanded')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
