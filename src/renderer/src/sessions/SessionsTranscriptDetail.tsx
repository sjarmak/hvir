import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import {
  MAX_SESSIONS_SUBMIT_MESSAGE,
  sessionsMutationUnavailableMessage,
  sessionsTranscriptUnavailableMessage,
  type SessionsMutationResponse,
  type SessionsMutationUnavailableReason,
  type SessionsTranscriptSnapshot,
  type SessionsTranscriptTurn,
  type SessionsTranscriptTurnRole,
} from '../../../shared'
import { useModalKeyboard } from '../workbench/use-modal-keyboard'
import type { SessionsTerminalDetailContext } from './sessions-terminal-detail-controller'

/**
 * The transcript of one projected session, and the two things a person may say
 * back to it.
 *
 * hvir is a reader of the transcript itself: the turns are already stripped of
 * control bytes for display, and the supervisor's own transcript is untouched.
 * Two things can be written from here, and only two — the answer to an
 * interaction the session declared it is waiting on, and a message sent to it.
 * Everything else a person might do to a session, from a reset to a handoff,
 * stays with the view that owns the city (ADR-048). Attach is still the escape
 * hatch for someone who wants a terminal of their own.
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
  onRespond,
  onSubmit,
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
  /** Answers the declared interaction by the position this pane rendered. */
  readonly onRespond?: (optionOrdinal: number) => Promise<SessionsMutationResponse>
  readonly onSubmit?: (message: string) => Promise<SessionsMutationResponse>
}): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  const log = useRef<HTMLOListElement>(null)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<SessionsMutationUnavailableReason>()
  const [draft, setDraft] = useState('')
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
  const pending = state?.status === 'ready' ? state.pending : undefined
  const answer = async (optionOrdinal: number): Promise<void> => {
    if (!onRespond || sending) return
    setFailure(undefined)
    setSending(true)
    const result = await onRespond(optionOrdinal)
    setSending(false)
    if (result.outcome === 'unavailable') setFailure(result.reason)
  }
  const send = async (): Promise<void> => {
    if (!onSubmit || sending) return
    setFailure(undefined)
    setSending(true)
    const result = await onSubmit(draft)
    setSending(false)
    if (result.outcome === 'unavailable') {
      setFailure(result.reason)
      return
    }
    // The message is the person's; it is cleared only once it has been taken.
    setDraft('')
  }
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
        {pending ? (
          <section className="sessions-transcript-pending" aria-label="Waiting on you">
            <p className="sessions-transcript-prompt">
              {pending.prompt ?? 'This session is waiting on an answer.'}
            </p>
            {pending.options.length > 0 ? (
              <div className="sessions-transcript-options">
                {pending.options.map((option) => (
                  <button
                    key={option.ordinal}
                    type="button"
                    disabled={sending}
                    onClick={() => void answer(option.ordinal)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
        {onSubmit && state?.status === 'ready' ? (
          <form
            className="sessions-transcript-compose"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <label htmlFor="sessions-transcript-message">
              {pending && pending.options.length === 0 ? 'Your answer' : 'Send a message'}
            </label>
            <textarea
              id="sessions-transcript-message"
              rows={2}
              value={draft}
              maxLength={MAX_SESSIONS_SUBMIT_MESSAGE}
              disabled={sending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={sending || draft.trim() === ''}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        ) : null}
        {failure ? (
          <p className="sessions-transcript-failure" role="alert">
            {sessionsMutationUnavailableMessage(failure)}
          </p>
        ) : null}
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
