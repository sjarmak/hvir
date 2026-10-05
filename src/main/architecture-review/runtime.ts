import { applicationUserDataPath } from '../application-runtime'
import type { WorkbenchRuntime } from '../workbench-runtime'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ArchitectureReviewCoordinator } from './coordinator'
import type { ArchitectureWorktreePort } from './handoff'
import { ArchitectureAnalysisWorker } from './worker'
import { CommitChangeStore } from './commit-change-store'
import { LocalHost } from '../project-host/local-host'
import { ARCHITECTURE_PARSE_CACHE_BYTES } from './parse-cache-budget'
import { HarnessArchitectureExplanationModel } from '../harness/architecture-explanation-model'
import type { HarnessProfileStoreContract } from '../harness/harness-profile-store'

/** Application state under Electron userData, shared by every repository reviewed. */
export function architectureParseCacheDirectory(): string {
  return applicationUserDataPath('architecture-parse-cache')
}

export function architectureCommitChangeDirectory(): string {
  return applicationUserDataPath('architecture-commit-classifications')
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
      commitChanges: new CommitChangeStore({
        files: new LocalHost(),
        directory: architectureCommitChangeDirectory(),
      }),
      handoff: { worktrees },
      explanationModel: new HarnessArchitectureExplanationModel(profiles),
    }),
    (review) => review.dispose(),
  )
}
