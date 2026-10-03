import { useCallback, useState } from 'react'

import type { ProjectState } from '../../../shared'
import { hostPathEquals } from '../../../shared'
import { useNeedsYouNavigation } from './use-needs-you-navigation'
import { useNeedsYouRailTarget } from './use-needs-you-rail-target'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'

export function useApplicationNavigation({
  projectState,
  root,
  switchWorkspace,
  onError,
  beadsEnabled,
  setRailMode,
}: {
  readonly projectState?: ProjectState
  readonly root?: ProjectState['root']
  readonly switchWorkspace: (projectId: string, workspaceId: string) => Promise<void>
  readonly onError: (message: string) => void
  readonly beadsEnabled: boolean
  readonly setRailMode: (mode: WorkbenchRailMode) => void
}) {
  const [destination, setDestinationState] = useState<
    'workspace' | 'sessions' | 'needs-you'
  >('workspace')
  const needsYou = useNeedsYouNavigation({
    projectState,
    switchWorkspace,
    onWorkspace: () => setDestinationState('workspace'),
    onError,
  })
  const { cancelPending } = needsYou
  const setDestination = useCallback(
    (next: 'workspace' | 'sessions' | 'needs-you'): void => {
      cancelPending()
      setDestinationState(next)
    },
    [cancelPending],
  )
  useNeedsYouRailTarget({
    destination,
    beadTarget: needsYou.beadTarget,
    beadsEnabled,
    setRailMode,
  })
  const beadTarget =
    needsYou.beadTarget && root && hostPathEquals(root, needsYou.beadTarget.root)
      ? needsYou.beadTarget
      : undefined
  return { destination, setDestination, needsYou, beadTarget }
}
