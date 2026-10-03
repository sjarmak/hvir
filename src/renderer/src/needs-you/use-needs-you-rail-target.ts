import { useEffect } from 'react'

import type { NeedsYouBeadTarget } from './needs-you-rows'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'

export function useNeedsYouRailTarget({
  destination,
  beadTarget,
  beadsEnabled,
  setRailMode,
}: {
  readonly destination: 'workspace' | 'sessions' | 'needs-you'
  readonly beadTarget?: NeedsYouBeadTarget
  readonly beadsEnabled: boolean
  readonly setRailMode: (mode: WorkbenchRailMode) => void
}): void {
  useEffect(() => {
    if (destination === 'workspace' && beadTarget && beadsEnabled) setRailMode('beads')
  }, [beadTarget, beadsEnabled, destination, setRailMode])
}
