import { useEffect, useRef, useState, type FormEvent } from 'react'

import type {
  CompanionRow,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import { COMPANION_KEYS } from './companion-keys'
import type { CompanionMirrorFeed } from './companion-mirror-feed'
import { companionMirrorEndMessage, type CompanionTerminalState } from './companion-store'
import { CompanionTerminalMount } from './companion-terminal-mount'
import type { CompanionTerminalPaneFactory } from './companion-terminal-pane'
import { TranscriptView } from './transcript-view'
import type { CompanionInputArmingControl } from './use-input-arming'

interface TerminalViewProps {
  readonly row: CompanionRow | undefined
  readonly terminal: CompanionTerminalState
  readonly transcript: SessionsTranscriptSnapshot | undefined
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly arming: CompanionInputArmingControl
  readonly onInput: (data: string) => Promise<void>
  readonly onBack: () => void
  readonly onResume: () => Promise<void>
  readonly onRespond: (optionOrdinal: number) => Promise<void>
  readonly onSubmit: (message: string) => Promise<boolean>
}

/**
 * One mirrored terminal (ADR-050): the desktop's screen at its geometry,
 * scaled to the phone, with typing behind an explicit arm control and the
 * keys a phone keyboard lacks. A row that also takes answers offers its
 * transcript beside the mirror.
 */
export function TerminalView(props: TerminalViewProps) {
  const { row, terminal, transcript, arming, onInput } = props
  const [showTranscript, setShowTranscript] = useState(false)
  const [paneFailure, setPaneFailure] = useState<string>()
  const live = terminal.status === 'live'
  const canType = live && arming.armed
  if (showTranscript && transcript !== undefined) {
    return (
      <TranscriptView
        row={row}
        transcript={transcript}
        backLabel="Terminal"
        onBack={() => setShowTranscript(false)}
        onResume={props.onResume}
        onRespond={props.onRespond}
        onSubmit={props.onSubmit}
      />
    )
  }
  return (
    <section className="companion-terminal">
      <header className="companion-transcript-header">
        <button
          type="button"
          className="companion-button companion-back"
          onClick={props.onBack}
        >
          Sessions
        </button>
        <h2 className="companion-transcript-title">{row?.title ?? terminal.handle}</h2>
        {row?.canAnswer && transcript !== undefined ? (
          <button
            type="button"
            className="companion-button"
            onClick={() => setShowTranscript(true)}
          >
            Transcript
          </button>
        ) : null}
      </header>
      {terminal.status === 'ended' ? (
        <p className="companion-status companion-mirror-ended">
          {companionMirrorEndMessage(terminal.reason)}
        </p>
      ) : null}
      {paneFailure === undefined ? null : (
        <p className="companion-error" role="alert">
          {paneFailure}
        </p>
      )}
      <TerminalSurface
        handle={terminal.handle}
        feed={props.feed}
        createPane={props.createPane}
        inputEnabled={canType}
        onInput={onInput}
        onFailure={(error) => setPaneFailure(describeFailure(error))}
      />
      <div className="companion-terminal-controls">
        <button
          type="button"
          className="companion-button companion-arm"
          data-armed={arming.armed ? 'true' : 'false'}
          disabled={!live}
          onClick={arming.armed ? arming.disarm : arming.arm}
        >
          {arming.armed ? 'Disarm' : 'Arm typing'}
        </button>
        <div className="companion-keys">
          {COMPANION_KEYS.map((key) => (
            <button
              key={key.label}
              type="button"
              className="companion-button companion-key"
              disabled={!canType}
              onClick={() => void onInput(key.data)}
            >
              {key.label}
            </button>
          ))}
        </div>
      </div>
      <TerminalTextForm enabled={canType} onInput={onInput} />
    </section>
  )
}

/** The pane's host: attached to the feed for this row while mounted. */
function TerminalSurface({
  handle,
  feed,
  createPane,
  inputEnabled,
  onInput,
  onFailure,
}: {
  readonly handle: SessionsTerminalHandle
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly inputEnabled: boolean
  readonly onInput: (data: string) => Promise<void>
  readonly onFailure: (error: unknown) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<CompanionTerminalMount>(undefined)
  const callbacks = useRef({ onInput, onFailure })
  callbacks.current = { onInput, onFailure }

  useEffect(() => {
    const element = host.current
    if (element === null) return
    const created = new CompanionTerminalMount(
      element,
      createPane,
      (data) => void callbacks.current.onInput(data),
      (error) => callbacks.current.onFailure(error),
    )
    mount.current = created
    const detach = feed.attach(handle, (event) => created.handle(event))
    return () => {
      detach()
      created.dispose()
      mount.current = undefined
    }
  }, [handle, feed, createPane])

  useEffect(() => {
    mount.current?.setInputEnabled(inputEnabled)
  }, [inputEnabled])

  return <div ref={host} className="companion-terminal-host" />
}

function describeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The terminal could not be shown: ${detail}`
}

/** Free text: Send posts it as typed; the keyboard's return posts it with Enter. */
function TerminalTextForm({
  enabled,
  onInput,
}: {
  readonly enabled: boolean
  readonly onInput: (data: string) => Promise<void>
}) {
  const [text, setText] = useState('')

  async function send(data: string): Promise<void> {
    if (!enabled || data === '') return
    setText('')
    await onInput(data)
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void send(`${text}\r`)
  }

  return (
    <form className="companion-terminal-form" onSubmit={submit}>
      <input
        id="companion-terminal-text"
        className="companion-input"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!enabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className="companion-button companion-button-primary"
        disabled={!enabled || text === ''}
        onClick={() => void send(text)}
      >
        Send
      </button>
    </form>
  )
}
