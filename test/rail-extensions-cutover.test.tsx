// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { RailTabs } from '../src/renderer/src/rail/RailExtensions'

it('keeps only core-owned rail tabs after the Beads package cutover', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => {
      root.render(
        <RailTabs
          rail={{ github: { pullsEnabled: true } }}
          layout={{ railMode: 'files', setRailMode: vi.fn() }}
        />,
      )
    })
    expect(host.textContent).toBe('PRs')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
