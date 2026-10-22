import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

import { activateViewerOverlay } from '../src/renderer/src/viewer/viewer-overlay-activation'

it.each(['architecture', 'web'] as const)(
  'clears extension and report overlays when the %s viewer activates',
  (surface) => {
    const ports = {
      deactivateExtensions: vi.fn(),
      deactivateReport: vi.fn(),
    }

    activateViewerOverlay(surface, ports)

    expect(ports.deactivateExtensions).toHaveBeenCalledOnce()
    expect(ports.deactivateReport).toHaveBeenCalledOnce()
  },
)

it('blocks viewer commands while a report overlay is active', () => {
  const app = readFileSync(
    new URL('../src/renderer/src/App.tsx', import.meta.url),
    'utf8',
  )
  expect(app).toMatch(/canUseViewerCommands:[\s\S]*?!viewer\.isReportActive\(\)/u)
})
