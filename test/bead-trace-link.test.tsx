// @vitest-environment happy-dom

import { createHash } from 'node:crypto'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BeadStore } from '../src/renderer/src/beads/analytics-links'
import { BeadTraceLink } from '../src/renderer/src/beads/BeadTraceLink'
import type { HoneycombLinkConfig } from '../src/shared'

const CONFIG: HoneycombLinkConfig = {
  team: 'steph.jarmak',
  environment: 'test',
  dataset: 'gas-city-agent',
}

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

const RIG_STORE: BeadStore = { kind: 'rig', name: 'mem' }
const CITY_STORE: BeadStore = { kind: 'city', name: 'hq' }

function expectedHash(beadId: string, storeRef = 'rig:mem'): string {
  return createHash('sha256').update(`["work","${storeRef}","${beadId}"]`).digest('hex')
}

function filterValue(column: string): string | undefined {
  const anchor = host.querySelector('a')
  if (!anchor) return undefined
  const query = new URL(anchor.getAttribute('href') ?? '').searchParams.get('query') ?? ''
  const spec = JSON.parse(query) as { filters: { column: string; value: string }[] }
  return spec.filters.find((filter) => filter.column === column)?.value
}

function workIdFilter(): string | undefined {
  const anchor = host.querySelector('a')
  if (!anchor) return undefined
  const query = new URL(anchor.getAttribute('href') ?? '').searchParams.get('query') ?? ''
  const spec = JSON.parse(query) as { filters: { column: string; value: string }[] }
  return spec.filters.find((filter) => filter.column === 'gc.work.id')?.value
}

/**
 * Wait for the digest to resolve rather than for one tick: how long it takes
 * depends on worker load. Each poll flushes React inside its own act, since
 * state set while an act is still pending is not committed until it ends.
 */
async function settle(until: () => void): Promise<void> {
  const deadline = Date.now() + 2000
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    try {
      until()
      return
    } catch (failure) {
      if (Date.now() > deadline) throw failure
    }
  }
}

describe('BeadTraceLink', () => {
  it('renders nothing until the work id hash resolves, then one anchor', async () => {
    act(() => {
      root.render(
        createElement(BeadTraceLink, {
          config: CONFIG,
          store: RIG_STORE,
          beadId: 'mem-42',
        }),
      )
    })
    expect(host.querySelector('a')).toBeNull()
    await settle(() => expect(host.querySelector('a')).not.toBeNull())
    const anchors = host.querySelectorAll('a')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.getAttribute('target')).toBe('_blank')
    expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchors[0]?.getAttribute('title')).toContain('last 2h')
    expect(workIdFilter()).toBe(expectedHash('mem-42'))
  })

  it('recomputes when the bead changes', async () => {
    act(() => {
      root.render(
        createElement(BeadTraceLink, {
          config: CONFIG,
          store: RIG_STORE,
          beadId: 'mem-42',
        }),
      )
    })
    await settle(() => expect(workIdFilter()).toBe(expectedHash('mem-42')))
    act(() => {
      root.render(
        createElement(BeadTraceLink, {
          config: CONFIG,
          store: RIG_STORE,
          beadId: 'mem-43',
        }),
      )
    })
    await settle(() => expect(workIdFilter()).toBe(expectedHash('mem-43')))
  })

  it('hashes a rig-owned bead under rig:<rig> and filters on the rig', async () => {
    act(() => {
      root.render(
        createElement(BeadTraceLink, {
          config: CONFIG,
          store: RIG_STORE,
          beadId: 'mem-42',
        }),
      )
    })
    await settle(() => expect(workIdFilter()).toBe(expectedHash('mem-42', 'rig:mem')))
    expect(filterValue('gc.rig')).toBe('mem')
  })

  it('hashes a city-owned bead under city:<hq rig> without a rig filter', async () => {
    act(() => {
      root.render(
        createElement(BeadTraceLink, {
          config: CONFIG,
          store: CITY_STORE,
          beadId: 'hq-7',
        }),
      )
    })
    await settle(() => expect(workIdFilter()).toBe(expectedHash('hq-7', 'city:hq')))
    expect(filterValue('gc.rig')).toBeUndefined()
    expect(host.querySelector('a')?.getAttribute('title')).toContain('city hq')
  })

  it('unmounts before the digest resolves without throwing or logging', async () => {
    act(() => {
      root.render(
        createElement(BeadTraceLink, {
          config: CONFIG,
          store: RIG_STORE,
          beadId: 'mem-42',
        }),
      )
    })
    act(() => root.unmount())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(host.querySelector('a')).toBeNull()
    root = createRoot(host)
  })
})
