import type { ReactElement } from 'react'

import type { AppTheme } from '../theme'
import { setAppTheme } from '../theme'
import type { SettingsSection } from '../settings/settings-navigation'
import { ProjectsBar } from './ProjectsBar'
import type { useExternalAttention } from './use-external-attention'
import type { useProjectSession } from './project-session'
import type { useTerminalAttention } from '../terminal/use-terminal-attention'

export function AppProjectNavigation({
  session,
  terminalAttention,
  externalAttention,
  overlays,
  theme,
  destination,
  setDestination,
}: {
  readonly session: ReturnType<typeof useProjectSession>
  readonly terminalAttention: ReturnType<typeof useTerminalAttention>
  readonly externalAttention: ReturnType<typeof useExternalAttention>
  readonly overlays: {
    readonly openProjectPicker: () => void
    readonly openSettings: (section?: SettingsSection) => void
  }
  readonly theme: AppTheme
  readonly destination: 'workspace' | 'sessions' | 'needs-you'
  readonly setDestination: (destination: 'workspace' | 'sessions' | 'needs-you') => void
}): ReactElement | null {
  if (!session.projectState) return null
  return (
    <ProjectsBar
      state={session.projectState}
      rollups={terminalAttention.rollups}
      external={externalAttention}
      busy={session.busy}
      onAdd={overlays.openProjectPicker}
      onSwitch={(projectId, workspaceId) => {
        setDestination('workspace')
        void session.switchWorkspace(projectId, workspaceId)
      }}
      onRefresh={(projectId) => void session.refreshProject(projectId)}
      onCloseProject={(projectId) => void session.closeProject(projectId)}
      onPrune={(projectId) => void session.pruneWorktrees(projectId)}
      onDismiss={(projectId, workspaceId) =>
        void session.dismissWorkspace(projectId, workspaceId)
      }
      onPlanCloseWorkspace={session.planWorkspaceClose}
      onCloseWorkspace={(projectId, workspaceId, plan, terminateTerminals) =>
        void session.closeWorkspace(projectId, workspaceId, plan, terminateTerminals)
      }
      onReopenWorkspace={(projectId, workspaceId) =>
        void session.reopenWorkspace(projectId, workspaceId)
      }
      watchTier={session.watchTier}
      statusError={session.error}
      onChangeConnection={overlays.openProjectPicker}
      onDisconnect={() => void session.disconnect()}
      onReconnect={() => void session.reconnect()}
      theme={theme}
      onTheme={setAppTheme}
      onSettings={() => overlays.openSettings()}
      sessionsActive={destination === 'sessions'}
      onSessions={() => setDestination('sessions')}
      needsYouActive={destination === 'needs-you'}
      onNeedsYou={() => setDestination('needs-you')}
    />
  )
}
