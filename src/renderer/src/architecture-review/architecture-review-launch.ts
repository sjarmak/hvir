import type {
  ArchitectureReviewLaunch,
  HarnessProfileId,
  HostPath,
} from '../../../shared'

export const ARCHITECTURE_REVIEW_LAUNCH_EVENT = 'hvir:architecture-review-launch'

export interface ArchitectureReviewLaunchDetail {
  readonly root: HostPath
  readonly launch: ArchitectureReviewLaunch
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly resolve: (accepted: boolean) => void
}

export function dispatchArchitectureReviewLaunch(
  detail: Omit<ArchitectureReviewLaunchDetail, 'resolve'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let claimed = false
    const complete = (accepted: boolean): void => {
      claimed = true
      resolve(accepted)
    }
    window.dispatchEvent(
      new CustomEvent<ArchitectureReviewLaunchDetail>(ARCHITECTURE_REVIEW_LAUNCH_EVENT, {
        detail: { ...detail, resolve: complete },
      }),
    )
    if (!claimed) resolve(false)
  })
}
