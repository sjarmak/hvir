import { useEffect, useRef, useState, type RefObject } from 'react'

import type {
  CompanionRow,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import type { CompanionMirrorFeed } from './companion-mirror-feed'
import { companionMirrorEndMessage, type CompanionTerminalState } from './companion-store'
import { CompanionTerminalMount } from './companion-terminal-mount'
import {
  readCompanionTextSize,
  stepCompanionTextSize,
  writeCompanionTextSize,
} from './companion-text-size'
import type { CompanionTerminalPaneFactory } from './companion-terminal-pane'
import { MirrorControls, ReturnToLive } from './mirror-controls'
import { MirrorHeader } from './mirror-header'
import { TranscriptView } from './transcript-view'
import type { CompanionInputVerb } from './use-companion-session'
import type { CompanionInputArmingControl } from './use-input-arming'

interface TerminalViewProps {
  readonly row: CompanionRow | undefined
  readonly terminal: CompanionTerminalState
  readonly transcript: SessionsTranscriptSnapshot | undefined
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly arming: CompanionInputArmingControl
  readonly onInput: CompanionInputVerb
  readonly onViewport: (cols: number, rows: number) => Promise<void>
  readonly onBack: () => void
  readonly onResume: () => Promise<void>
  readonly onRespond: (optionOrdinal: number) => Promise<void>
  readonly onSubmit: (message: string) => Promise<boolean>
}

/**
 * A full-screen program's earlier turns live in the program rather than in the
 * emulator, so a drag pages the program through them (ADR-055). The emulator
 * has no scrollback here; the session is not without history.
 */
const OWN_HISTORY = 'This program keeps its own history. Drag to page back through it.'

/**
 * One mirrored terminal (ADR-050) filling the phone's screen: a one-line
 * header, the terminal in all the height that remains (the phone's own grid,
 * which it holds the PTY at while it watches), and one compact control bar at
 * the bottom. Reading back is the emulator's own viewport under a finger or a wheel (ADR-053), so the area
 * holds the grid and the page's stated states beside it and never a second
 * surface of text. A viewport left behind the newest output puts the way back
 * over that area, outside the host's own scroller so it keeps its place over a
 * grid taller than the phone. A full-screen program has no scrollback for a
 * viewport to be behind, so it is offered the way back under no condition and
 * the record's promise of no affordance that moves nothing holds here rather
 * than in the emulator. While the row carries a prompt, its message is
 * the header's second line (ADR-051). A row that also takes answers offers its
 * transcript beside the mirror.
 */
export function TerminalView(props: TerminalViewProps) {
  const { row, terminal, transcript, arming, onInput, onViewport } = props
  const [showTranscript, setShowTranscript] = useState(false)
  const [paneFailure, setPaneFailure] = useState<string>()
  const [alternateScreen, setAlternateScreen] = useState(false)
  const [readingBack, setReadingBack] = useState(false)
  const [textSize, setTextSize] = useState(() => readCompanionTextSize(localStorage))
  const mirror = useRef<CompanionTerminalMount>(undefined)
  const live = terminal.status === 'live'
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
      <MirrorHeader
        title={row?.title ?? terminal.handle}
        promptBody={row?.promptBody}
        offersTranscript={row?.canAnswer === true && transcript !== undefined}
        onBack={props.onBack}
        onTranscript={() => setShowTranscript(true)}
        textSize={textSize}
        onTextSize={(direction) => {
          const next = stepCompanionTextSize(textSize, direction)
          setTextSize(next)
          writeCompanionTextSize(localStorage, next)
        }}
      />
      <div className="companion-terminal-area">
        {terminal.status === 'ended' ? (
          <p className="companion-status companion-mirror-ended">
            {companionMirrorEndMessage(terminal.reason)}
          </p>
        ) : null}
        {!alternateScreen ? null : (
          <p className="companion-status companion-mirror-own-history" role="status">
            {OWN_HISTORY}
          </p>
        )}
        {paneFailure === undefined ? null : (
          <p className="companion-error" role="alert">
            {paneFailure}
          </p>
        )}
        <TerminalSurface
          handle={terminal.handle}
          feed={props.feed}
          createPane={props.createPane}
          inputEnabled={arming.armed}
          textSize={textSize}
          mirror={mirror}
          onInput={onInput}
          onViewport={onViewport}
          onAlternateScreen={setAlternateScreen}
          onReadingBack={setReadingBack}
          onFailure={(error) => setPaneFailure(describeFailure(error))}
        />
        {alternateScreen || !readingBack ? null : (
          <ReturnToLive onReturn={() => mirror.current?.returnToLive()} />
        )}
      </div>
      <MirrorControls live={live} arming={arming} onInput={onInput} />
    </section>
  )
}

/** The pane's host: attached to the feed for this row while mounted. */
function TerminalSurface({
  handle,
  feed,
  createPane,
  inputEnabled,
  textSize,
  mirror,
  onInput,
  onViewport,
  onAlternateScreen,
  onReadingBack,
  onFailure,
}: {
  readonly handle: SessionsTerminalHandle
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly inputEnabled: boolean
  /** The person's mirror text size (ADR-059), which every pane this surface builds draws at. */
  readonly textSize: number
  /** The mount the view holds, so the way back reaches the pane this surface owns. */
  readonly mirror: RefObject<CompanionTerminalMount | undefined>
  readonly onInput: CompanionInputVerb
  readonly onViewport: (cols: number, rows: number) => Promise<void>
  readonly onAlternateScreen: (alternate: boolean) => void
  readonly onReadingBack: (readingBack: boolean) => void
  readonly onFailure: (error: unknown) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  // Read when a pane is built rather than depended on, so a step of the size
  // changes the pane the mirror already has instead of rebuilding the mirror.
  const size = useRef(textSize)
  size.current = textSize
  const callbacks = useRef({
    onInput,
    onViewport,
    onAlternateScreen,
    onReadingBack,
    onFailure,
  })
  callbacks.current = { onInput, onViewport, onAlternateScreen, onReadingBack, onFailure }

  useEffect(() => {
    const element = host.current
    if (element === null) return
    const created = new CompanionTerminalMount({
      host: element,
      createPane,
      onInput: (data, source) => void callbacks.current.onInput(data, source),
      onViewport: (cols, rows) => callbacks.current.onViewport(cols, rows),
      onAlternateScreen: (alternate) => callbacks.current.onAlternateScreen(alternate),
      onReadingBack: (readingBack) => callbacks.current.onReadingBack(readingBack),
      onFailure: (error) => callbacks.current.onFailure(error),
      textSize: size.current,
    })
    mirror.current = created
    const detach = feed.attach(handle, (event) => created.handle(event))
    return () => {
      detach()
      created.dispose()
      mirror.current = undefined
      // A surface rebuilt for another row leaves no way back to the one before
      // it: there is no mount to answer the tap until the next mirror opens.
      callbacks.current.onReadingBack(false)
    }
  }, [handle, feed, createPane, mirror])

  useEffect(() => {
    mirror.current?.setInputEnabled(inputEnabled)
  }, [inputEnabled, mirror])

  useEffect(() => {
    mirror.current?.setTextSize(textSize)
  }, [textSize, mirror])

  return <div ref={host} className="companion-terminal-host" />
}

function describeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The terminal could not be shown: ${detail}`
}
