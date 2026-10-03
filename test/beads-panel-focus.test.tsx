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
      labels: ['needs-human'],
      dependencyCount: 0,
      dependentCount: 0,
    },
    {
      id: 'mem-2',
      title: 'Gate it',
      status: 'open',
      priority: 2,
      issueType: 'gate',
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
let beadResponses: (BeadsListResponse | Promise<BeadsListResponse>)[] | undefined

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as () => void
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const invoke = vi.fn((channel: string) => {
    switch (channel) {
      case 'beads:list':
        return Promise.resolve(beadResponses?.shift() ?? BEADS)
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
  beadResponses = undefined
})

async function renderPanel(
  props: Partial<Parameters<typeof BeadsPanel>[0]> = {},
): Promise<void> {
  act(() => {
    root.render(
      createElement(BeadsPanel, {
        root: ROOT,
        connected: true,
        onCrewAction: () => undefined,
        ...props,
      }),
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

function heldChip(id: string): HTMLButtonElement {
  const chip = [...host.querySelectorAll<HTMLButtonElement>('.crew-held-bead')].find(
    (button) => button.textContent?.includes(id),
  )
  if (!chip) throw new Error(`no held chip for ${id}`)
  return chip
}

function sectionHeaderOf(beadId: string): HTMLButtonElement {
  const header = host
    .querySelector(`[data-bead-id="${beadId}"]`)
    ?.closest('.beads-section')
    ?.querySelector<HTMLButtonElement>('.beads-section-header')
  if (!header) throw new Error(`no section header around ${beadId}`)
  return header
}

describe('BeadsPanel held-bead focus', () => {
  it('refreshes immediately for an incoming target on an already visible panel', async () => {
    await renderPanel()
    beadResponses = [
      {
        ...BEADS,
        issues: BEADS.issues.map((issue) => ({ ...issue, title: 'Fresh title' })),
      },
    ]
    const onFocusHandled = vi.fn()

    await renderPanel({ focusBeadId: 'mem-1', onFocusHandled })

    expect(host.textContent).toContain('Fresh title')
    expect(onFocusHandled).toHaveBeenCalledWith('mem-1')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('focuses an externally selected bead after its list arrives', async () => {
    const onFocusHandled = vi.fn()
    await renderPanel({ focusBeadId: 'mem-1', onFocusHandled })

    const row = host.querySelector('[data-bead-id="mem-1"]')
    expect(row?.querySelector('.beads-row')?.classList.contains('expanded')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(onFocusHandled).toHaveBeenCalledWith('mem-1')
  })

  it('reports a selected bead that the fresh list no longer exposes', async () => {
    const onFocusUnavailable = vi.fn()
    await renderPanel({ focusBeadId: 'mem-gone', onFocusUnavailable })

    expect(onFocusUnavailable).toHaveBeenCalledWith('mem-gone')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('waits for a fresh actionable list instead of focusing cached placement', async () => {
    let release!: (response: BeadsListResponse) => void
    await renderPanel()
    beadResponses = [
      new Promise<BeadsListResponse>((resolve) => {
        release = resolve
      }),
    ]
    const onFocusHandled = vi.fn()
    act(() => {
      root.render(
        createElement(BeadsPanel, {
          root: ROOT,
          connected: true,
          hidden: true,
          focusBeadId: 'mem-1',
          onFocusHandled,
          onCrewAction: () => undefined,
        }),
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(onFocusHandled).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()

    const removed = {
      ...BEADS,
      issues: BEADS.issues.map((issue) =>
        issue.id === 'mem-1' ? { ...issue, labels: [] } : issue,
      ),
    }
    act(() => {
      root.render(
        createElement(BeadsPanel, {
          root: ROOT,
          connected: true,
          focusBeadId: 'mem-1',
          onFocusHandled,
          onCrewAction: () => undefined,
        }),
      )
    })
    await act(async () => {
      release(removed)
      await Promise.resolve()
    })
    expect(onFocusHandled).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('clicking a held bead on a crew card expands and scrolls its bead row', async () => {
    await renderPanel()
    const row = host.querySelector('[data-bead-id="mem-1"]')
    expect(row).not.toBeNull()
    const button = heldChip('mem-1')
    expect(row?.querySelector('.beads-row')?.classList.contains('expanded')).toBe(false)

    act(() => {
      button.click()
    })

    expect(row?.querySelector('.beads-row')?.classList.contains('expanded')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('reopens a collapsed section before scrolling to the row', async () => {
    await renderPanel()
    const header = sectionHeaderOf('mem-1')
    act(() => {
      header.click()
    })
    expect(host.querySelector('[data-bead-id="mem-1"]')).toBeNull()
    expect(header.getAttribute('aria-expanded')).toBe('false')

    act(() => {
      heldChip('mem-1').click()
    })

    const row = host.querySelector('[data-bead-id="mem-1"]')
    expect(row).not.toBeNull()
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(row?.querySelector('.beads-row')?.classList.contains('expanded')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('disables the chip of a held bead the sections do not render', async () => {
    await renderPanel()
    expect(host.querySelector('[data-bead-id="mem-2"]')).toBeNull()
    const chip = heldChip('mem-2')
    expect(chip.disabled).toBe(true)
    expect(chip.title).toContain('hidden by the current filters')
    expect(heldChip('mem-1').disabled).toBe(false)
  })
})
