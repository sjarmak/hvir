import type { WorkbenchRuntime } from '../workbench-runtime'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ArchitectureReviewCoordinator } from './coordinator'
import { analyzeInWorker } from './worker'
export function createArchitectureReview(
  resources: RendererResourceScopes,
  runtime: Pick<WorkbenchRuntime, 'own'>,
): ArchitectureReviewCoordinator {
  return runtime.own('architecture review', new ArchitectureReviewCoordinator({ resources, analyze: analyzeInWorker }), (review) => review.dispose())
}
