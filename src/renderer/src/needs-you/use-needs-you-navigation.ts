import { useCallback, useEffect, useRef, useState } from 'react'

import {
  hostPathEquals,
  isBeadId,
  type ProjectState,
  type SessionsProjectionRow,
} from '../../../shared'
import type { NeedsYouBeadTarget } from './NeedsYouView'

export type { NeedsYouBeadTarget }

export interface NeedsYouNavigation {
  readonly sessionTarget?: SessionsProjectionRow
  readonly beadTarget?: NeedsYouBeadTarget
  readonly selectSession: (row: SessionsProjectionRow) => void
  readonly sessionHandled: () => void
  readonly selectBead: (target: NeedsYouBeadTarget) => Promise<boolean>
  readonly cancelPending: () => void
  readonly beadHandled: (id: string) => void
  readonly beadUnavailable: (id: string) => void
}

export function useNeedsYouNavigation({
  projectState,
  switchWorkspace,
  onWorkspace,
  onError,
}: {
  readonly projectState?: ProjectState
  readonly switchWorkspace: (projectId: string, workspaceId: string) => Promise<void>
  readonly onWorkspace: () => void
  readonly onError: (message: string) => void
}): NeedsYouNavigation {
  const [sessionTarget, setSessionTarget] = useState<SessionsProjectionRow>()
  const [beadTarget, setBeadTarget] = useState<NeedsYouBeadTarget>()
  const beadTargetRef = useRef<NeedsYouBeadTarget | undefined>(undefined)
  const requestSerial = useRef(0)
  useEffect(
    () => () => {
      requestSerial.current += 1
    },
    [],
  )

  const selectSession = useCallback((row: SessionsProjectionRow): void => {
    requestSerial.current += 1
    beadTargetRef.current = undefined
    setBeadTarget(undefined)
    setSessionTarget(row)
  }, [])
  const sessionHandled = useCallback((): void => {
    setSessionTarget(undefined)
  }, [])

  const selectBead = useCallback(
    async (target: NeedsYouBeadTarget): Promise<boolean> => {
      const serial = ++requestSerial.current
      const project = projectState?.projects.find(
        (candidate) => candidate.id === target.projectId,
      )
      const workspace = project?.workspaces.find(
        (candidate) => candidate.id === target.workspaceId,
      )
      if (!isNeedsYouWorkspaceTarget(project, workspace, target)) {
        throw new Error('That bead is no longer available in its workspace.')
      }
      beadTargetRef.current = target
      setBeadTarget(target)
      try {
        await switchWorkspace(target.projectId, target.workspaceId)
        if (serial !== requestSerial.current) return false
        onWorkspace()
        return true
      } catch (reason) {
        if (serial !== requestSerial.current) return false
        setBeadTarget(undefined)
        beadTargetRef.current = undefined
        throw reason
      }
    },
    [onWorkspace, projectState, switchWorkspace],
  )
  const cancelPending = useCallback((): void => {
    requestSerial.current += 1
    beadTargetRef.current = undefined
    setBeadTarget(undefined)
    setSessionTarget(undefined)
  }, [])

  const beadHandled = useCallback((id: string): void => {
    if (beadTargetRef.current?.beadId !== id) return
    beadTargetRef.current = undefined
    setBeadTarget(undefined)
  }, [])
  const beadUnavailable = useCallback(
    (id: string): void => {
      if (beadTargetRef.current?.beadId !== id) return
      beadTargetRef.current = undefined
      setBeadTarget(undefined)
      onError('That bead is no longer actionable in its workspace.')
    },
    [onError],
  )

  return {
    sessionTarget,
    beadTarget,
    selectSession,
    sessionHandled,
    selectBead,
    cancelPending,
    beadHandled,
    beadUnavailable,
  }
}

export function isNeedsYouWorkspaceTarget(
  project: ProjectState['projects'][number] | undefined,
  workspace: ProjectState['projects'][number]['workspaces'][number] | undefined,
  target: NeedsYouBeadTarget,
): boolean {
  return Boolean(
    project &&
    workspace &&
    project.connectionState === 'connected' &&
    project.id === target.projectId &&
    workspace.id === target.workspaceId &&
    isBeadId(target.beadId) &&
    !workspace.closed &&
    !workspace.missing &&
    hostPathEquals(workspace.root, target.root),
  )
}
