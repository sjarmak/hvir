// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useGasCityCrew } from '../src/renderer/src/beads/use-gascity-crew'
import { asHostId, hostPath, type HostPath } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/home/dev/city/rigs/mem')
const OTHER = hostPath(asHostId('local'), '/home/dev/city/rigs/aoa')

let host: HTMLDivElement
let root: Root
let invoke: Mock<(channel: string, payload?: unknown) => Promise<unknown>>

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  invoke = vi.fn((channel: string) =>
    channel === 'gascity:probe'
      ? Promise.resolve({ hasCity: true })
      : Promise.resolve({ available: true, members: [], scope: 'rig' }),
  )
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.hvir = {
    invoke,
    on: () => () => undefined,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function Probe({
  workspace,
  hidden,
}: {
  readonly workspace: HostPath
  readonly hidden: boolean
}): ReactElement {
  useGasCityCrew({
    root: workspace,
    connected: true,
    hidden,
    includeInternals: false,
  })
  return createElement('div')
}

async function render(workspace: HostPath, hidden: boolean): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { workspace, hidden }))
    await Promise.resolve()
  })
}

function channels(): string[] {
  return invoke.mock.calls.map((call) => String(call[0]))
}

describe('useGasCityCrew', () => {
  it('does not probe for a section the user has not opened', async () => {
    // The panel stays mounted behind the Files and Git tabs, and the probe
    // walks up to a dozen directory levels — one round trip each over SSH.
    await render(ROOT, true)
    expect(channels()).toEqual([])
  })

  it('probes once the section becomes visible', async () => {
    await render(ROOT, true)
    await render(ROOT, false)
    expect(channels()).toContain('gascity:probe')
  })

  it('probes again for a different workspace', async () => {
    await render(ROOT, false)
    await render(OTHER, false)
    const probed = invoke.mock.calls
      .filter((call) => call[0] === 'gascity:probe')
      .map((call) => (call[1] as { root: HostPath }).root.path)
    expect(probed).toEqual([ROOT.path, OTHER.path])
  })

  it('does not re-probe the same workspace when the section is hidden and shown', async () => {
    await render(ROOT, false)
    await render(ROOT, true)
    await render(ROOT, false)
    const probes = channels().filter((channel) => channel === 'gascity:probe')
    expect(probes).toHaveLength(1)
  })

  it('never invokes gc for a workspace outside a city', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'gascity:probe') return Promise.resolve({ hasCity: false })
      throw new Error('crew must not be requested')
    })
    await render(ROOT, false)
    expect(channels()).toEqual(['gascity:probe'])
  })
})
