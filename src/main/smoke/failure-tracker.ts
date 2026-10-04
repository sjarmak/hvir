import {
  reportSmokeFailureEvidence,
  smokeCleanupResource,
  type SmokeFailureCheckpoint,
  type SmokeFailurePhase,
  type SmokeOwnedResourceEvidence,
} from './failure-evidence.mts'

type SmokeFailureReporter = (
  phase: SmokeFailurePhase,
  owners: SmokeOwnedResourceEvidence,
  checkpoint?: SmokeFailureCheckpoint | null,
  cleanupResource?: ReturnType<typeof smokeCleanupResource>,
) => void

export function createSmokeFailureTracker(
  owners: () => SmokeOwnedResourceEvidence,
  report: SmokeFailureReporter = reportSmokeFailureEvidence,
) {
  let phase: SmokeFailurePhase = 'resources-created'
  let checkpoint: SmokeFailureCheckpoint | null = null
  let cleanupResource: ReturnType<typeof smokeCleanupResource> = null

  const recordPhase = (nextPhase: SmokeFailurePhase): void => {
    phase = nextPhase
    checkpoint = null
    report(phase, owners())
  }
  const recordCheckpoint = (nextCheckpoint: SmokeFailureCheckpoint): void => {
    checkpoint = nextCheckpoint
    report(phase, owners(), checkpoint)
  }
  const recordCleanupFailure = (name: string): void => {
    cleanupResource = smokeCleanupResource(name)
    report('cleanup', owners(), null, cleanupResource)
  }
  const reportFailure = (): void => report(phase, owners(), checkpoint)
  const reportCleanup = (): void => report('cleanup', owners(), null, cleanupResource)

  return {
    recordPhase,
    recordCheckpoint,
    recordCleanupFailure,
    reportFailure,
    reportCleanup,
  }
}
