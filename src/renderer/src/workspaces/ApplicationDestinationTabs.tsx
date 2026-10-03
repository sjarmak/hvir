import type { ReactElement } from 'react'

export function ApplicationDestinationTabs({
  sessionsActive,
  onSessions,
  needsYouActive,
  onNeedsYou,
}: {
  readonly sessionsActive: boolean
  readonly onSessions: () => void
  readonly needsYouActive: boolean
  readonly onNeedsYou: () => void
}): ReactElement {
  return (
    <>
      <button
        type="button"
        className={`sessions-destination${sessionsActive ? ' active' : ''}`}
        aria-current={sessionsActive ? 'page' : undefined}
        onClick={onSessions}
      >
        Sessions
      </button>
      <button
        type="button"
        className={`sessions-destination${needsYouActive ? ' active' : ''}`}
        aria-current={needsYouActive ? 'page' : undefined}
        onClick={onNeedsYou}
      >
        Needs you
      </button>
    </>
  )
}
