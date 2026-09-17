import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'

import type {
  SessionsTranscriptSnapshot,
  SessionsTranscriptTurn,
  SessionsTranscriptTurnRole,
} from '../../../shared'
import { useModalKeyboard } from '../workbench/use-modal-keyboard'
import type { SessionsTerminalDetailContext } from './sessions-terminal-detail-controller'
import { sessionsTranscriptUnavailableMessage } from './sessions-transcript-coordinator'

/**
 * The transcript of one projected session, read only.
 *
 * hvir is a reader here: the turns are already stripped of control bytes for
 * display, the supervisor's own transcript is untouched, and nothing in this
 * pane can write to the session. Attach is the escape hatch for a person who
 * wants to type.
 */
export function SessionsTranscriptDetail({
  context,
  sourceName,
  state,
  origin,
  attaching,
  onBack,
  onResume,
  onAttach,
  onShowTerminal,
}: {
  readonly context: SessionsTerminalDetailContext
  /** The owning authority's display name, so the pane says whose session it is. */
  readonly sourceName: string
  readonly state?: SessionsTranscriptSnapshot
  readonly origin?: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
  readonly attaching?: boolean
  readonly onBack: () => void
  readonly onResume: () => void
  readonly onAttach?: () => void
  readonly onShowTerminal?: () => void
}): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  const log = useRef<HTMLOListElement>(null)
  useModalKeyboard(dialog, onBack)
  const turns = state?.turns ?? []
  const last = turns.at(-1)?.ordinal
  useEffect(() => {
    // New turns arrive at the tail, so the pane follows the tail. The scroll is
    // the only thing that moves; the turns themselves are immutable.
    const element = log.current
    if (element) element.scrollTop = element.scrollHeight
  }, [last])
  const originStyle = origin
    ? ({
        '--sessions-detail-origin-top': `${origin.top}px`,
        '--sessions-detail-origin-right': `calc(100vw - ${origin.right}px)`,
        '--sessions-detail-origin-bottom': `calc(100vh - ${origin.bottom}px)`,
        '--sessions-detail-origin-left': `${origin.left}px`,
      } as CSSProperties)
    : undefined
  return (
    <div className="sessions-detail-backdrop" style={originStyle}>
      <section
        ref={dialog}
        className="sessions-terminal-detail sessions-transcript-detail"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="sessions-transcript-title"
      >
        <header className="sessions-detail-header">
          <div>
            <h1 id="sessions-transcript-title">{context.title}</h1>
            <p>
              {sourceName} <span aria-hidden="true">·</span> {context.projectName}{' '}
              <span aria-hidden="true">/</span> {context.workspaceName} ·{' '}
              {context.hostLabel} · {context.providerName}
            </p>
          </div>
          <div className="sessions-detail-actions">
            <button type="button" autoFocus onClick={onBack}>
              Close
            </button>
            {onShowTerminal ? (
              <button type="button" onClick={onShowTerminal}>
                Show terminal
              </button>
            ) : null}
            {onAttach ? (
              <button type="button" disabled={attaching} onClick={onAttach}>
                {attaching ? 'Attaching…' : 'Attach'}
              </button>
            ) : null}
            {state?.stream === 'lost' ? (
              <button type="button" onClick={onResume}>
                Reconnect
              </button>
            ) : null}
          </div>
        </header>
        <p className="sessions-detail-status" role="status">
          {transcriptStatusMessage(state)}
        </p>
        <ol
          ref={log}
          className="sessions-transcript-turns"
          aria-label={`${context.title} transcript`}
        >
          {turns.map((turn) => (
            <li key={turn.ordinal} className={`sessions-transcript-turn ${turn.role}`}>
              <p className="sessions-transcript-turn-meta">
                <span className="sessions-transcript-role">{roleLabel(turn.role)}</span>
                {turnLabel(turn) ? <span>{turnLabel(turn)}</span> : null}
                {turn.at ? <time dateTime={turn.at}>{turn.at}</time> : null}
                {turn.failed ? (
                  <span className="sessions-transcript-failed">failed</span>
                ) : null}
                {turn.partial ? <span aria-label="still arriving">…</span> : null}
              </p>
              <p className="sessions-transcript-text">
                {turn.text}
                {turn.truncated ? (
                  <span className="sessions-transcript-cut"> (cut to fit)</span>
                ) : null}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

/**
 * One line that says both what the transcript is and what the stream is doing.
 * A lost stream is stated, never papered over: the turns above it are still
 * real, they have simply stopped growing until someone reconnects.
 */
function transcriptStatusMessage(state: SessionsTranscriptSnapshot | undefined): string {
  if (!state || state.status === 'loading') return 'Reading the transcript…'
  if (state.status === 'unavailable')
    return state.reason === undefined
      ? 'This transcript is unavailable.'
      : sessionsTranscriptUnavailableMessage(state.reason)
  const held = state.older
    ? `Showing the last ${state.turns.length} turns; earlier turns stay with the supervisor.`
    : `Showing ${state.turns.length} ${state.turns.length === 1 ? 'turn' : 'turns'}.`
  switch (state.stream) {
    case 'opening':
      return `${held} Following the session…`
    case 'live':
      return `${held} Following live.`
    case 'lost':
      return `${held} ${
        state.streamReason === undefined
          ? 'The live stream stopped.'
          : sessionsTranscriptUnavailableMessage(state.streamReason)
      } Reconnect to follow it again.`
    case 'closed':
      return `${held} Not following.`
  }
}

function roleLabel(role: SessionsTranscriptTurnRole): string {
  switch (role) {
    case 'user':
      return 'User'
    case 'assistant':
      return 'Agent'
    case 'system':
      return 'System'
    case 'tool':
      return 'Tool'
    case 'unknown':
      return 'Unrecognized'
  }
}

function turnLabel(turn: SessionsTranscriptTurn): string | undefined {
  switch (turn.kind) {
    case 'text':
      return undefined
    case 'tool-use':
      return turn.toolName ?? 'tool use'
    case 'tool-result':
      return `${turn.toolName ?? 'tool'} result`
    case 'interaction':
      return 'waiting for a person'
    case 'image':
      return 'image'
    case 'event':
      return 'event'
    case 'unknown':
      return 'unrecognized block'
  }
}
