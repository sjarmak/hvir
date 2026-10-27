import type { ReactElement } from 'react'

export function ApplicationDestinationTabs({
  sessionsActive,
  onSessions,
}: {
  readonly sessionsActive: boolean
  readonly onSessions: () => void
}): ReactElement {
  return (
    <button
      type="button"
      className={`sessions-destination${sessionsActive ? ' active' : ''}`}
      aria-current={sessionsActive ? 'page' : undefined}
      onClick={onSessions}
    >
      Sessions
    </button>
  )
}
