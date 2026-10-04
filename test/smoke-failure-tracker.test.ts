import { describe, expect, it, vi } from 'vitest'
import { createSmokeFailureTracker } from '../src/main/smoke/failure-tracker'
import type { SmokeOwnedResourceEvidence } from '../src/main/smoke/failure-evidence.mts'

const owners: SmokeOwnedResourceEvidence = {
  windowCount: 1,
  ptyCount: 2,
  watcherActive: true,
  rendererOwnerActive: true,
  rendererGeneration: 3,
}

describe('smoke failure tracker', () => {
  it('reports the latest phase and checkpoint for a scenario failure', () => {
    const report = vi.fn()
    const tracker = createSmokeFailureTracker(() => owners, report)

    tracker.recordPhase('window-ready')
    tracker.recordCheckpoint('renderer-recovery-route-opening')
    tracker.reportFailure()

    expect(report).toHaveBeenLastCalledWith(
      'window-ready',
      owners,
      'renderer-recovery-route-opening',
    )
  })

  it('reports the accepted cleanup resource during cleanup and finalization', () => {
    const report = vi.fn()
    const tracker = createSmokeFailureTracker(() => owners, report)

    tracker.recordCleanupFailure('project watch')
    tracker.reportCleanup()

    expect(report).toHaveBeenNthCalledWith(1, 'cleanup', owners, null, 'project watch')
    expect(report).toHaveBeenNthCalledWith(2, 'cleanup', owners, null, 'project watch')
  })
})
