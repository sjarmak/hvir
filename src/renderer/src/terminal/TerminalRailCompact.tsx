import type { ReactElement } from 'react'

import { terminalAttentionDescription, type TerminalAttention } from './terminal-attention'
import {
  compactAttentionRollups,
  compactAttentionSummary,
} from './terminal-rail-compact-rollups'
import type { TerminalSession } from './terminal-workspace-model'

export function TerminalRailCompact({
  hidden,
  sessions,
  activeId,
  onFocusSession,
  onRestore,
}: {
  readonly hidden: boolean
  readonly sessions: readonly TerminalSession[]
  readonly activeId?: string
  readonly onFocusSession: (id: string) => void
  readonly onRestore: () => void
}): ReactElement {
  const rollups = compactAttentionRollups(sessions.map((session) => session.attention))

  return (
    <div className="terminal-rail-compact-strip" hidden={hidden}>
      <button
        type="button"
        className="terminal-rail-restore"
        aria-label="Restore terminal rail"
        title="Restore terminal rail"
        onClick={onRestore}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path d="M11.5 3 7 8l4.5 5M7.5 3 3 8l4.5 5" />
        </svg>
      </button>
      <div
        className="terminal-rail-compact-rollups"
        role="status"
        aria-label={compactAttentionSummary(rollups)}
      >
        {rollups.map((rollup) => (
          <span
            key={rollup.state}
            className={`terminal-rail-compact-rollup ${rollup.state}`}
            aria-label={rollup.label}
            title={rollup.label}
          >
            <span aria-hidden="true">{rollup.letter}</span>
            {rollup.count}
          </span>
        ))}
      </div>
      <div
        className="terminal-rail-compact-markers"
        role="list"
        aria-label="Open terminals"
      >
        {sessions.map((session) => {
          const state = session.attention ?? 'neutral'
          const active = session.id === activeId
          const label = markerLabel(session, state, active)
          return (
            <div
              key={session.id}
              className="terminal-rail-compact-marker-item"
              role="listitem"
            >
              <button
                type="button"
                className={`terminal-rail-compact-marker ${state}${active ? ' active' : ''}`}
                data-terminal-session={session.id}
                data-terminal-state={state}
                aria-current={active ? 'true' : undefined}
                aria-label={label}
                title={label}
                onClick={() => onFocusSession(session.id)}
              >
                <span aria-hidden="true">{MARKER_TEXT[state]}</span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type CompactTerminalState = TerminalAttention | 'neutral'

const MARKER_TEXT: Record<CompactTerminalState, string> = {
  neutral: '',
  working: '…',
  idle: 'R',
  bell: 'B',
  prompt: 'P',
}

function markerLabel(
  session: TerminalSession,
  state: CompactTerminalState,
  active: boolean,
): string {
  const stateLabel =
    state === 'neutral'
      ? 'Neutral'
      : terminalAttentionDescription(state, session.promptBody)
  return `${session.title}, ${stateLabel}${active ? ', active terminal' : ''}`
}
