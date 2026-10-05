import { describe, expect, it, vi } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as generators from '@hegeldev/hegel/generators'
import { createSmokeFailureTracker } from '../src/main/smoke/failure-tracker'
import {
  SMOKE_FAILURE_CHECKPOINTS,
  SMOKE_FAILURE_PHASES,
  type SmokeOwnedResourceEvidence,
} from '../src/main/smoke/failure-evidence.mts'

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

  it('clears the checkpoint when the scenario advances to a new phase', () => {
    const report = vi.fn()
    const tracker = createSmokeFailureTracker(() => owners, report)

    tracker.recordCheckpoint('renderer-recovery-route-opening')
    tracker.recordPhase('window-ready')
    tracker.reportFailure()

    expect(report).toHaveBeenLastCalledWith('window-ready', owners, null)
  })

  it('clears every checkpoint across every phase transition', () =>
    hegel.test((testCase) => {
      const checkpoint = testCase.draw(generators.sampledFrom(SMOKE_FAILURE_CHECKPOINTS))
      const phase = testCase.draw(generators.sampledFrom(SMOKE_FAILURE_PHASES))
      const report = vi.fn()
      const tracker = createSmokeFailureTracker(() => owners, report)

      tracker.recordCheckpoint(checkpoint)
      tracker.recordPhase(phase)
      tracker.reportFailure()

      expect(report).toHaveBeenLastCalledWith(phase, owners, null)
    }))

  it('reports a checkpoint immediately under the initial resources-created phase', () => {
    const report = vi.fn()
    const tracker = createSmokeFailureTracker(() => owners, report)

    tracker.recordCheckpoint('renderer-recovery-route-opening')

    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(
      'resources-created',
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
