import { hostPathEquals, type HarnessProfile, type StartPtyRequest } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ArchitectureReviewCoordinator } from './coordinator'
/**
 * Native terminal launch admission for one handed-off worktree, never an ambient terminal:
 * the session starts in the worktree the handoff created and spends its one launch.
 */
export function architectureLaunchBody(
  request: StartPtyRequest,
  owner: RendererOwner,
  host: ProjectHost,
  profile: HarnessProfile,
  reviews: Pick<ArchitectureReviewCoordinator, 'launchPayload'>,
): string | undefined {
  const launch = request.architectureReview
  if (launch === undefined) return undefined
  if (
    !launch ||
    typeof launch.handoffId !== 'string' ||
    !launch.root ||
    request.resume ||
    (request.launchMode !== undefined && request.launchMode !== 'fresh') ||
    request.replacesSessionId ||
    request.externalAttach ||
    !hostPathEquals(request.workspaceRoot, launch.root) ||
    !hostPathEquals(request.cwd, launch.root) ||
    host.hostId !== launch.root.hostId ||
    profile.executable.kind !== 'provider-default' ||
    profile.args.length !== 0
  )
    throw new Error(
      'Architecture review requires a fresh native profile in its handoff worktree; custom arguments are unsupported',
    )
  return reviews.launchPayload(owner, host, launch)
}
