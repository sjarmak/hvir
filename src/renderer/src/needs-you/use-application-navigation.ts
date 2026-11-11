import { useCallback, useState } from 'react'

import type { ProjectState } from '../../../shared'
import { hostPathEquals } from '../../../shared'
import { useNeedsYouNavigation } from './use-needs-you-navigation'

export function useApplicationNavigation({
  projectState,
  root,
  switchWorkspace,
  onError,
}: {
  readonly projectState?: ProjectState
  readonly root?: ProjectState['root']
  readonly switchWorkspace: (projectId: string, workspaceId: string) => Promise<void>
  readonly onError: (message: string) => void
}) {
  const [destination, setDestinationState] = useState<
    'workspace' | 'sessions' | 'needs-you' | 'extension'
  >('workspace')
  const needsYou = useNeedsYouNavigation({
    projectState,
    switchWorkspace,
    onWorkspace: () => setDestinationState('workspace'),
    onError,
  })
  const { cancelPending } = needsYou
  const setDestination = useCallback(
    (next: 'workspace' | 'sessions' | 'needs-you' | 'extension'): void => {
      cancelPending()
      setDestinationState(next)
    },
    [cancelPending],
  )
  const beadTarget =
    needsYou.beadTarget && root && hostPathEquals(root, needsYou.beadTarget.root)
      ? needsYou.beadTarget
      : undefined
  const extensionTarget = {
    targetedView: beadTarget
      ? {
          requestId: beadTarget.beadId,
          extensionId: 'beads-extension',
          contributionId: 'beads',
          workspaceId: beadTarget.workspaceId,
          input: { focusBeadId: beadTarget.beadId },
        }
      : undefined,
    onTargetedViewOpened: needsYou.beadHandled,
    onTargetedViewUnavailable: needsYou.beadUnavailable,
  }
  return { destination, setDestination, needsYou, beadTarget, extensionTarget }
}
