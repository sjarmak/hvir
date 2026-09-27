import { applicationUserDataPath } from '../application-runtime'
import type { WorkbenchRuntime } from '../workbench-runtime'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ArchitectureReviewCoordinator } from './coordinator'
import type { ArchitectureWorktreePort } from './handoff'
import { ArchitectureAnalysisWorker } from './worker'
import { ARCHITECTURE_PARSE_CACHE_BYTES } from './parse-cache-budget'
import { HarnessArchitectureExplanationModel } from '../harness/architecture-explanation-model'
import type { HarnessProfileStoreContract } from '../harness/harness-profile-store'

/** Application state under Electron userData, shared by every repository reviewed. */
export function architectureParseCacheDirectory(): string {
  return applicationUserDataPath('architecture-parse-cache')
}

export function ownArchitectureReview(
  resources: RendererResourceScopes,
  runtime: Pick<WorkbenchRuntime, 'own'>,
  worktrees: ArchitectureWorktreePort,
  profiles: HarnessProfileStoreContract,
): ArchitectureReviewCoordinator {
  const worker = runtime.own(
    'architecture analysis worker',
    new ArchitectureAnalysisWorker({
      cache: {
        directory: architectureParseCacheDirectory(),
        maxBytes: ARCHITECTURE_PARSE_CACHE_BYTES,
      },
    }),
    (owned) => owned.dispose(),
  )
  return runtime.own(
    'architecture review',
    new ArchitectureReviewCoordinator({
      resources,
      analyze: worker.analyze,
      imports: worker.imports,
      handoff: { worktrees },
      explanationModel: new HarnessArchitectureExplanationModel(profiles),
    }),
    (review) => review.dispose(),
  )
}
