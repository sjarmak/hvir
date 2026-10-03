import type { ReactElement } from 'react'

import type {
  ProjectState,
  SessionsAttachExternalTarget,
  SessionsProjectionRow,
} from '../../../shared'
import { NeedsYouView } from './NeedsYouView'
import type { NeedsYouBeadTarget } from './use-needs-you-navigation'
import { SessionsApplicationDestination } from '../sessions/SessionsApplicationDestination'
import type { SessionsProjectionCoordinator } from '../sessions/sessions-projection-coordinator'

type SessionsRuntime = Parameters<typeof SessionsApplicationDestination>[0]['runtime']

export function ApplicationDestinations({
  destination,
  runtime,
  projection,
  sessionTarget,
  onOpened,
  onError,
  onAttachExternal,
  onSession,
  onBead,
}: {
  readonly destination: 'workspace' | 'sessions' | 'needs-you'
  readonly runtime: SessionsRuntime
  readonly projection: SessionsProjectionCoordinator
  readonly sessionTarget?: SessionsProjectionRow
  readonly onOpened: (state: ProjectState) => void
  readonly onError: (message: string) => void
  readonly onAttachExternal: (
    workspaceId: string,
    target: SessionsAttachExternalTarget,
  ) => Promise<boolean>
  readonly onSession: (row: SessionsProjectionRow) => void
  readonly onBead: (target: NeedsYouBeadTarget) => Promise<boolean | void>
}): ReactElement {
  return (
    <>
      <SessionsApplicationDestination
        active={destination === 'sessions'}
        runtime={runtime}
        initialTarget={sessionTarget}
        onOpened={onOpened}
        onError={onError}
        onAttachExternal={onAttachExternal}
      />
      {destination === 'needs-you' ? (
        <NeedsYouView
          projection={projection}
          onSession={onSession}
          onBead={onBead}
          onError={onError}
        />
      ) : null}
    </>
  )
}
