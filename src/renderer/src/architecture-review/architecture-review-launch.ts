import type { ArchitectureAgentLaunch, HarnessProfileId, HostPath } from '../../../shared'

/** Announces a queued launch to terminal workspaces that are already mounted. */
export const ARCHITECTURE_AGENT_LAUNCH_QUEUED = 'hvir:architecture-agent-launch-queued'

export interface PendingArchitectureAgentLaunch {
  readonly launch: ArchitectureAgentLaunch
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
}

/**
 * The handed-off worktree becomes a new workspace, so the review panel that asked for the
 * launch unmounts before the worktree's terminal mounts. This mailbox carries the one
 * launch across that switch; the worktree's terminal claims it once it can launch.
 */
const pending = new Map<string, PendingArchitectureAgentLaunch>()

function keyOf(root: HostPath): string {
  return JSON.stringify([root.hostId, root.path])
}

export function queueArchitectureAgentLaunch(
  request: PendingArchitectureAgentLaunch,
): void {
  pending.set(keyOf(request.launch.root), request)
  window.dispatchEvent(new Event(ARCHITECTURE_AGENT_LAUNCH_QUEUED))
}

/**
 * Offers the launch queued for `root` to `attempt`: `undefined` keeps it queued until the
 * terminal is ready, a boolean settles it either way so it never launches twice.
 */
export function claimArchitectureAgentLaunch(
  root: HostPath,
  attempt: (request: PendingArchitectureAgentLaunch) => boolean | undefined,
): boolean | undefined {
  const key = keyOf(root)
  const request = pending.get(key)
  if (!request) return undefined
  const outcome = attempt(request)
  if (outcome !== undefined) pending.delete(key)
  return outcome
}
