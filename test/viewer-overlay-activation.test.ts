import { expect, it, vi } from 'vitest'

import { deactivateViewerOverlays } from '../src/renderer/src/viewer/viewer-overlay-activation'

it('deactivates extension and report overlays before another viewer surface activates', () => {
  const deactivateExtensions = vi.fn()
  const deactivateReport = vi.fn()

  deactivateViewerOverlays({ deactivateExtensions, deactivateReport })

  expect(deactivateExtensions).toHaveBeenCalledOnce()
  expect(deactivateReport).toHaveBeenCalledOnce()
})
