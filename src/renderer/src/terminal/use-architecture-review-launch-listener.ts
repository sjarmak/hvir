import { useEffect } from 'react'

import {
  hostPathEquals,
  type ArchitectureAgentLaunch,
  type HostPath,
} from '../../../shared'
import {
  ARCHITECTURE_AGENT_LAUNCH_QUEUED,
  claimArchitectureAgentLaunch,
  type PendingArchitectureAgentLaunch,
} from '../architecture-review/architecture-review-launch'
import { BEAD_COMMAND_EVENT, type BeadCommandDetail } from '../beads/bead-launch-event'

interface ArchitectureReviewLaunchCommands {
  readonly launchArchitectureReview: (
    profileId: PendingArchitectureAgentLaunch['profileId'],
    launch: ArchitectureAgentLaunch,
    launchRevision: number,
  ) => boolean | undefined
  readonly launchBeadCommand: (command: string) => boolean
}

export function useArchitectureReviewLaunchListener(
  workspaceRoot: HostPath,
  commands: ArchitectureReviewLaunchCommands,
): void {
  useEffect(() => {
    // Claim on every commit: the queued launch waits until profiles and the PTY are ready.
    const claim = (): void => {
      claimArchitectureAgentLaunch(workspaceRoot, (request) =>
        commands.launchArchitectureReview(
          request.profileId,
          request.launch,
          request.launchRevision,
        ),
      )
    }
    claim()
    window.addEventListener(ARCHITECTURE_AGENT_LAUNCH_QUEUED, claim)
    const handleBead = (event: Event): void => {
      const detail = (event as CustomEvent<BeadCommandDetail>).detail
      if (!detail || !hostPathEquals(detail.root, workspaceRoot)) return
      detail.resolve(commands.launchBeadCommand(detail.command))
    }
    window.addEventListener(BEAD_COMMAND_EVENT, handleBead)
    return () => {
      window.removeEventListener(ARCHITECTURE_AGENT_LAUNCH_QUEUED, claim)
      window.removeEventListener(BEAD_COMMAND_EVENT, handleBead)
    }
  }, [commands, workspaceRoot])
}
