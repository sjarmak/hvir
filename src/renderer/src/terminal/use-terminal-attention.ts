import { useCallback, useEffect, useState } from 'react'

import type {
  WorkspaceAttentionRollup,
  WorkspaceAttentionRollups,
} from '../workspaces/project-session-model'

/**
 * Terminal attention rollups, and the OS badge count.
 *
 * `externalWaiting` is the attention external agent sessions are raising that
 * hvir is watching right now. Only a watched count is included: the badge is a
 * number with nowhere to say that it is stale, so ADR-048 keeps an unwatched
 * count out of it, while the in-app badges carry it with its reason.
 */
export function useTerminalAttention(externalWaiting = 0) {
  const [rollups, setRollups] = useState<WorkspaceAttentionRollups>({})
  const updateRollup = useCallback(
    (workspaceId: string, rollup: WorkspaceAttentionRollup): void => {
      setRollups((current) => {
        const existing = current[workspaceId]
        if (
          existing?.actionable === rollup.actionable &&
          existing.working === rollup.working
        ) {
          return current
        }
        return { ...current, [workspaceId]: rollup }
      })
    },
    [],
  )
  const actionable =
    Object.values(rollups).reduce((total, rollup) => total + rollup.actionable, 0) +
    externalWaiting

  useEffect(() => {
    window.hvir.send('app:attention', { count: actionable })
  }, [actionable])
  useEffect(() => () => window.hvir.send('app:attention', { count: 0 }), [])

  return { rollups, updateRollup }
}
