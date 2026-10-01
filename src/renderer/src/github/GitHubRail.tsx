import { useEffect, useState, type ReactElement } from 'react'

import type { HostConnectionState, HostPath, ProjectState } from '../../../shared'
import type { WorkbenchRailMode } from '../workbench/use-workbench-layout'
import { PullsPanel } from './PullsPanel'

interface GitHubRailSession {
  readonly root?: HostPath
  readonly connectionState: HostConnectionState
  readonly projectState?: ProjectState
  readonly switchWorkspace: (projectId: string, workspaceId: string) => Promise<void>
  readonly reopenWorkspace: (projectId: string, workspaceId: string) => Promise<void>
}

interface GitHubRailLayout {
  readonly railMode: WorkbenchRailMode
  readonly setRailMode: (mode: WorkbenchRailMode) => void
}

export interface GitHubWorkspace {
  readonly pullsEnabled: boolean
}

export function useGitHubWorkspace(
  session: GitHubRailSession,
  layout: GitHubRailLayout,
): GitHubWorkspace {
  const { root, connectionState } = session
  const { railMode, setRailMode } = layout
  const [pullsEnabled, setPullsEnabled] = useState(false)

  useEffect(() => {
    if (!root || connectionState !== 'connected') {
      setPullsEnabled(false)
      return
    }
    let cancelled = false
    void window.hvir
      .invoke('github:probe', { root })
      .then((result) => {
        if (!cancelled) setPullsEnabled(result.hasGitHubRemote)
      })
      .catch((reason: unknown) => {
        console.error('[github] probe failed', reason)
        if (!cancelled) setPullsEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [root, connectionState])

  useEffect(() => {
    if (!pullsEnabled && railMode === 'pulls') setRailMode('files')
  }, [pullsEnabled, railMode, setRailMode])

  return { pullsEnabled }
}

export function GitHubRailTab({
  github,
  layout,
}: {
  readonly github: GitHubWorkspace
  readonly layout: GitHubRailLayout
}): ReactElement | null {
  if (!github.pullsEnabled) return null
  const active = layout.railMode === 'pulls'
  return (
    <button
      type="button"
      className={active ? 'active' : ''}
      aria-current={active ? 'page' : undefined}
      onClick={() => layout.setRailMode('pulls')}
    >
      PRs
    </button>
  )
}

export function GitHubRailPanel({
  github,
  session,
  layout,
}: {
  readonly github: GitHubWorkspace
  readonly session: GitHubRailSession
  readonly layout: Pick<GitHubRailLayout, 'railMode'>
}): ReactElement | null {
  if (!github.pullsEnabled || !session.root) return null
  const root = session.root
  const state = session.projectState
  const project = state?.projects.find(
    (candidate) => candidate.id === state.activeProjectId,
  )
  return (
    <PullsPanel
      key={`pulls:${root.hostId}:${root.path}`}
      root={root}
      connected={session.connectionState === 'connected'}
      hidden={layout.railMode !== 'pulls'}
      navigation={
        project && state
          ? {
              workspaces: project.workspaces,
              activeWorkspaceId: state.activeWorkspaceId,
              open: (workspace) =>
                workspace.closed
                  ? session.reopenWorkspace(project.id, workspace.id)
                  : session.switchWorkspace(project.id, workspace.id),
            }
          : undefined
      }
    />
  )
}
