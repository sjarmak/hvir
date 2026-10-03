import type { ReactElement } from 'react'

import type { ProjectState, SessionsAttachExternalTarget } from '../../../shared'
import { ApplicationDestinations } from './ApplicationDestinations'
import type { useNeedsYouNavigation } from './use-needs-you-navigation'

type ApplicationProps = Parameters<typeof ApplicationDestinations>[0]

export function AppApplicationDestinations({
  destination,
  runtime,
  projection,
  sessionTarget,
  needsYou,
  showTerminal,
  accept,
  setDestination,
  onError,
  onAttachExternal,
}: {
  readonly destination: ApplicationProps['destination']
  readonly runtime: ApplicationProps['runtime']
  readonly projection: ApplicationProps['projection']
  readonly sessionTarget: ApplicationProps['sessionTarget']
  readonly needsYou: ReturnType<typeof useNeedsYouNavigation>
  readonly showTerminal: () => void
  readonly accept: (state: ProjectState) => void
  readonly setDestination: (destination: ApplicationProps['destination']) => void
  readonly onError: (message: string) => void
  readonly onAttachExternal: (
    workspaceId: string,
    target: SessionsAttachExternalTarget,
  ) => Promise<boolean>
}): ReactElement {
  return (
    <ApplicationDestinations
      destination={destination}
      runtime={runtime}
      projection={projection}
      sessionTarget={sessionTarget}
      onOpened={(state) => {
        needsYou.sessionHandled()
        showTerminal()
        accept(state)
        setDestination('workspace')
      }}
      onError={onError}
      onAttachExternal={onAttachExternal}
      onSession={(row) => {
        setDestination('sessions')
        needsYou.selectSession(row)
      }}
      onBead={async (target) => {
        await needsYou.selectBead(target)
      }}
    />
  )
}
