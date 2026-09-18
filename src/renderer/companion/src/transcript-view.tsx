import { useState, type FormEvent } from 'react'

import type {
  CompanionRow,
  SessionsTranscriptPending,
  SessionsTranscriptSnapshot,
  SessionsTranscriptTurn,
} from '../../../shared'
import { MAX_SESSIONS_SUBMIT_MESSAGE } from '../../../shared'

interface TranscriptViewProps {
  readonly row: CompanionRow | undefined
  readonly transcript: SessionsTranscriptSnapshot
  readonly onBack: () => void
  readonly onResume: () => Promise<void>
  readonly onRespond: (optionOrdinal: number) => Promise<void>
  readonly onSubmit: (message: string) => Promise<boolean>
}

/** One selected row: its recent turns, what it is waiting on, and a reply box. */
export function TranscriptView(props: TranscriptViewProps) {
  const { row, transcript, onBack, onResume, onRespond, onSubmit } = props
  const canAnswer = row?.canAnswer ?? false
  return (
    <section className="companion-transcript">
      <header className="companion-transcript-header">
        <button
          type="button"
          className="companion-button companion-back"
          onClick={onBack}
        >
          Sessions
        </button>
        <h2 className="companion-transcript-title">{row?.title ?? transcript.handle}</h2>
      </header>
      <TranscriptStatus transcript={transcript} onResume={onResume} />
      <TranscriptTurns transcript={transcript} />
      {transcript.pending === undefined ? null : (
        <PendingInteraction
          pending={transcript.pending}
          enabled={canAnswer}
          onRespond={onRespond}
        />
      )}
      {canAnswer ? <MessageForm onSubmit={onSubmit} /> : null}
    </section>
  )
}

function TranscriptStatus({
  transcript,
  onResume,
}: {
  readonly transcript: SessionsTranscriptSnapshot
  readonly onResume: () => Promise<void>
}) {
  if (transcript.status === 'loading') {
    return <p className="companion-status">Loading the transcript</p>
  }
  if (transcript.status === 'unavailable') {
    return (
      <p className="companion-status companion-unavailable">
        Transcript unavailable ({transcript.reason ?? 'unknown'})
      </p>
    )
  }
  if (transcript.stream === 'live') return null
  const reason =
    transcript.streamReason === undefined ? '' : ` (${transcript.streamReason})`
  return (
    <div className="companion-stream">
      <span>
        Stream {transcript.stream}
        {reason}
      </span>
      {transcript.stream === 'lost' ? (
        <button
          type="button"
          className="companion-button"
          onClick={() => void onResume()}
        >
          Resume
        </button>
      ) : null}
    </div>
  )
}

function TranscriptTurns({
  transcript,
}: {
  readonly transcript: SessionsTranscriptSnapshot
}) {
  return (
    <>
      {transcript.older || transcript.dropped > 0 ? (
        <p className="companion-status">
          {transcript.dropped > 0
            ? `${transcript.dropped} earlier turns not shown. `
            : ''}
          {transcript.older ? 'Older turns stay on the desktop.' : ''}
        </p>
      ) : null}
      <ol className="companion-turns">
        {transcript.turns.map((turn) => (
          <Turn key={turn.ordinal} turn={turn} />
        ))}
      </ol>
    </>
  )
}

function Turn({ turn }: { readonly turn: SessionsTranscriptTurn }) {
  const flags = [
    turn.partial ? 'companion-turn-partial' : '',
    turn.failed ? 'companion-turn-failed' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <li className={`companion-turn companion-turn-${turn.role} ${flags}`.trim()}>
      <span className="companion-turn-role">{turn.role}</span>
      {turn.toolName === undefined ? null : (
        <span className="companion-turn-tool"> {turn.toolName}</span>
      )}
      <span className="companion-turn-text">{turn.text}</span>
      {turn.truncated ? <span className="companion-turn-cut"> [cut]</span> : null}
    </li>
  )
}

function PendingInteraction({
  pending,
  enabled,
  onRespond,
}: {
  readonly pending: SessionsTranscriptPending
  readonly enabled: boolean
  readonly onRespond: (optionOrdinal: number) => Promise<void>
}) {
  return (
    <section className="companion-pending">
      {pending.prompt === undefined ? null : (
        <p className="companion-pending-prompt">{pending.prompt}</p>
      )}
      {pending.options.length === 0 ? (
        <p className="companion-status">Waiting for a typed answer.</p>
      ) : (
        <div className="companion-options">
          {pending.options.map((option) => (
            <button
              key={option.ordinal}
              type="button"
              className="companion-button companion-option"
              disabled={!enabled}
              onClick={() => void onRespond(option.ordinal)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function MessageForm({
  onSubmit,
}: {
  readonly onSubmit: (message: string) => Promise<boolean>
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const empty = message.trim() === ''

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (empty || busy) return
    setBusy(true)
    try {
      if (await onSubmit(message)) setMessage('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="companion-message-form" onSubmit={(event) => void submit(event)}>
      <label className="companion-label" htmlFor="companion-message">
        Message
      </label>
      <textarea
        id="companion-message"
        className="companion-input companion-message"
        rows={3}
        maxLength={MAX_SESSIONS_SUBMIT_MESSAGE}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <button
        type="submit"
        className="companion-button companion-button-primary"
        disabled={busy || empty}
      >
        Send
      </button>
    </form>
  )
}
