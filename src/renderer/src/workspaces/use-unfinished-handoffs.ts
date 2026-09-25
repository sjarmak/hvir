import { useEffect, useState } from 'react'

import type { RegisteredProjectState } from '../../../shared'

const HANDOFF_BRANCH_PREFIX = 'hvir/architecture/'
const NONE: ReadonlySet<string> = new Set()

/**
 * The workspaces main judges to be unfinished architecture handoffs (ADR-063). The
 * renderer only asks when a workspace sits on a handoff branch; main reads every fact
 * from disk and Git and re-checks them all before any removal.
 */
export function useUnfinishedHandoffs(
  project: RegisteredProjectState | undefined,
  revision: number,
): ReadonlySet<string> {
  const [marked, setMarked] = useState<{
    readonly key: string
    readonly ids: ReadonlySet<string>
  }>()
  const candidates =
    project?.connectionState === 'connected'
      ? project.workspaces.filter(
          (workspace) =>
            !workspace.main &&
            !workspace.missing &&
            workspace.branch?.startsWith(HANDOFF_BRANCH_PREFIX) === true,
        )
      : []
  const projectId = project?.id
  const key =
    projectId && candidates.length > 0
      ? JSON.stringify([
          projectId,
          revision,
          candidates.map((workspace) => [workspace.id, workspace.head]),
        ])
      : ''

  useEffect(() => {
    if (!projectId || key === '') return
    let current = true
    void window.hvir
      .invoke('workspace:unfinished-handoffs', { projectId })
      .then((result) => {
        if (current && result.ok) setMarked({ key, ids: new Set(result.value) })
      })
    return () => {
      current = false
    }
  }, [projectId, key])

  return key !== '' && marked?.key === key ? marked.ids : NONE
}
