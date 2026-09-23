import { useEffect } from 'react'

import { hostPathEquals, type HostPath } from '../../../shared'
import {
  ARCHITECTURE_REVIEW_LAUNCH_EVENT,
  type ArchitectureReviewLaunchDetail,
} from '../architecture-review/architecture-review-launch'
import { BEAD_COMMAND_EVENT, type BeadCommandDetail } from '../beads/bead-launch-event'

interface ArchitectureReviewLaunchCommands {
  readonly launchArchitectureReview: (
    profileId: ArchitectureReviewLaunchDetail['profileId'],
    launch: ArchitectureReviewLaunchDetail['launch'],
    launchRevision: number,
  ) => boolean
  readonly launchBeadCommand: (command: string) => boolean
}

export function useArchitectureReviewLaunchListener(
  workspaceRoot: HostPath,
  commands: ArchitectureReviewLaunchCommands,
): void {
  useEffect(() => {
    const handleLaunch = (event: Event): void => {
      const detail = (event as CustomEvent<ArchitectureReviewLaunchDetail>).detail
      if (!detail || !hostPathEquals(detail.root, workspaceRoot)) return
      detail.resolve(
        commands.launchArchitectureReview(
          detail.profileId,
          detail.launch,
          detail.launchRevision,
        ),
      )
    }
    window.addEventListener(ARCHITECTURE_REVIEW_LAUNCH_EVENT, handleLaunch)
    const handleBead = (event: Event): void => {
      const detail = (event as CustomEvent<BeadCommandDetail>).detail
      if (!detail || !hostPathEquals(detail.root, workspaceRoot)) return
      detail.resolve(commands.launchBeadCommand(detail.command))
    }
    window.addEventListener(BEAD_COMMAND_EVENT, handleBead)
    return () => {
      window.removeEventListener(ARCHITECTURE_REVIEW_LAUNCH_EVENT, handleLaunch)
      window.removeEventListener(BEAD_COMMAND_EVENT, handleBead)
    }
  }, [commands, workspaceRoot])
}
