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
