import { hostPathEquals, type HarnessProfile, type StartPtyRequest } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ArchitectureReviewCoordinator } from './coordinator'
/** Native terminal launch admission for one prepared snapshot, never an ambient terminal. */
export async function architectureLaunchBody(
  request: StartPtyRequest,
  owner: RendererOwner,
  host: ProjectHost,
  profile: HarnessProfile,
  reviews: Pick<ArchitectureReviewCoordinator, 'launchPayload'>,
): Promise<string | undefined> {
  const evidence = request.architectureReview
  if (evidence === undefined) return undefined
  if (
    !evidence ||
    !evidence.root ||
    !evidence.path ||
    request.resume ||
    (request.launchMode !== undefined && request.launchMode !== 'fresh') ||
    request.replacesSessionId ||
    request.externalAttach ||
    !hostPathEquals(request.workspaceRoot, evidence.root) ||
    !hostPathEquals(request.cwd, evidence.root) ||
    host.hostId !== evidence.root.hostId ||
    profile.executable.kind !== 'provider-default' ||
    profile.args.length !== 0
  )
    throw new Error(
      'Architecture review requires a fresh native profile in its exact workspace; custom arguments are unsupported',
    )
  return reviews.launchPayload(owner, host, evidence)
}
