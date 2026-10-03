import type { ReactElement } from 'react'

import type {
  ProjectState,
  SessionsAttachExternalTarget,
  SessionsLivePtyQualifier,
  SessionsTerminalHandle,
  SessionsProjectionRow,
  SessionsWorkspaceQualifier,
} from '../../../shared'
import type { SessionsCommandPort } from './sessions-command-port'
import type { SessionsProjectionCoordinator } from './sessions-projection-coordinator'
import type { SessionsTerminalSurfacePort } from './sessions-terminal-surface'
import { SessionsOverview } from './SessionsOverview'

interface SessionsDestinationRuntime {
  readonly sessionsCommands: SessionsCommandPort
  readonly sessionsProjection: SessionsProjectionCoordinator
  readonly sessionsSurface: SessionsTerminalSurfacePort
  readonly focusProjectedSession: (
    handle: SessionsTerminalHandle,
    workspaceQualifier: SessionsWorkspaceQualifier,
    livePty: SessionsLivePtyQualifier,
  ) => Promise<boolean>
}

export function SessionsApplicationDestination({
  active,
  runtime,
  onOpened,
  onError,
  onAttachExternal,
  initialTarget,
}: {
  readonly active: boolean
  readonly runtime: SessionsDestinationRuntime
  readonly onOpened: (state: ProjectState) => void
  readonly onError: (message: string) => void
  /** Runs main's attach command in the workspace the attach switched to. */
  readonly onAttachExternal: (
    workspaceId: string,
    target: SessionsAttachExternalTarget,
  ) => Promise<boolean>
  readonly initialTarget?: SessionsProjectionRow
}): ReactElement | null {
  if (!active) return null
  return (
    <SessionsOverview
      commands={runtime.sessionsCommands}
      projection={runtime.sessionsProjection}
      surface={runtime.sessionsSurface}
      onOpened={onOpened}
      onFocusOpened={runtime.focusProjectedSession}
      onOpenFailed={onError}
      onAttachExternal={onAttachExternal}
      initialTarget={initialTarget}
    />
  )
}
