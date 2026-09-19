import { useEffect, useRef, useState, type RefObject } from 'react'

import type {
  CompanionRow,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import type { CompanionMirrorFeed } from './companion-mirror-feed'
import { companionMirrorEndMessage, type CompanionTerminalState } from './companion-store'
import type { CompanionResizeAnswer } from './companion-terminal-fit'
import { CompanionTerminalMount } from './companion-terminal-mount'
import type { CompanionTerminalPaneFactory } from './companion-terminal-pane'
import { MirrorControls, ReturnToLive } from './mirror-controls'
import { MirrorHeader } from './mirror-header'
import { TranscriptView } from './transcript-view'
import type { CompanionInputVerb } from './use-companion-session'
import type { CompanionInputArmingControl } from './use-input-arming'

type ResizeVerb = (cols: number, rows: number) => Promise<CompanionResizeAnswer>

interface TerminalViewProps {
  readonly row: CompanionRow | undefined
  readonly terminal: CompanionTerminalState
  readonly transcript: SessionsTranscriptSnapshot | undefined
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly arming: CompanionInputArmingControl
  /** The snapshot's word on the desktop's focus; the pane asks for its size only while Away. */
  readonly away: boolean
  readonly onInput: CompanionInputVerb
  readonly onResize: ResizeVerb
  readonly onBack: () => void
  readonly onResume: () => Promise<void>
  readonly onRespond: (optionOrdinal: number) => Promise<void>
  readonly onSubmit: (message: string) => Promise<boolean>
}

/** The Away door said no (ADR-052): a status, not an error; the scaled mirror stays. */
const DESKTOP_KEEPS_SIZE = 'The desktop is focused, so it keeps the terminal size.'
/**
 * A full-screen program's earlier turns live in the program rather than in the
 * emulator, so a drag pages the program through them (ADR-055). The emulator
 * has no scrollback here; the session is not without history.
 */
const OWN_HISTORY = 'This program keeps its own history. Drag to page back through it.'

/**
 * One mirrored terminal (ADR-050) filling the phone's screen: a one-line
 * header, the terminal in all the height that remains (the desktop's grid
 * scaled to the phone's width, or the phone's own grid unscaled while it holds
 * the size), and one compact control bar at the bottom. Reading back is the
 * emulator's own viewport under a finger or a wheel (ADR-053), so the area
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
  const { row, terminal, transcript, arming, onInput, onResize } = props
  const [showTranscript, setShowTranscript] = useState(false)
  const [paneFailure, setPaneFailure] = useState<string>()
  const [sizeStatus, setSizeStatus] = useState<string>()
  const [alternateScreen, setAlternateScreen] = useState(false)
  const [readingBack, setReadingBack] = useState(false)
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
  const sizeAnswered = (answer: CompanionResizeAnswer): void =>
    setSizeStatus(answer?.outcome === 'refused' ? DESKTOP_KEEPS_SIZE : undefined)
  return (
    <section className="companion-terminal">
      <MirrorHeader
        title={row?.title ?? terminal.handle}
        promptBody={row?.promptBody}
        offersTranscript={row?.canAnswer === true && transcript !== undefined}
        onBack={props.onBack}
        onTranscript={() => setShowTranscript(true)}
      />
      <div className="companion-terminal-area">
        {terminal.status === 'ended' ? (
          <p className="companion-status companion-mirror-ended">
            {companionMirrorEndMessage(terminal.reason)}
          </p>
        ) : null}
        {sizeStatus === undefined || !live ? null : (
          <p className="companion-status companion-mirror-size" role="status">
            {sizeStatus}
          </p>
        )}
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
          away={props.away}
          mirror={mirror}
          onInput={onInput}
          onResize={onResize}
          onResizeAnswered={sizeAnswered}
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

/**
 * The pane's host: attached to the feed for this row while mounted. A mount
 * built while the desktop is already Away learns that at once; later flips
 * reach it through the effect below.
 */
function TerminalSurface({
  handle,
  feed,
  createPane,
  inputEnabled,
  away,
  mirror,
  onInput,
  onResize,
  onResizeAnswered,
  onAlternateScreen,
  onReadingBack,
  onFailure,
}: {
  readonly handle: SessionsTerminalHandle
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly inputEnabled: boolean
  readonly away: boolean
  /** The mount the view holds, so the way back reaches the pane this surface owns. */
  readonly mirror: RefObject<CompanionTerminalMount | undefined>
  readonly onInput: CompanionInputVerb
  readonly onResize: ResizeVerb
  readonly onResizeAnswered: (answer: CompanionResizeAnswer) => void
  readonly onAlternateScreen: (alternate: boolean) => void
  readonly onReadingBack: (readingBack: boolean) => void
  readonly onFailure: (error: unknown) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({
    onInput,
    onResize,
    onResizeAnswered,
    onAlternateScreen,
    onReadingBack,
    onFailure,
  })
  callbacks.current = {
    onInput,
    onResize,
    onResizeAnswered,
    onAlternateScreen,
    onReadingBack,
    onFailure,
  }
  const awayNow = useRef(away)
  awayNow.current = away

  useEffect(() => {
    const element = host.current
    if (element === null) return
    const created = new CompanionTerminalMount({
      host: element,
      createPane,
      onInput: (data, source) => void callbacks.current.onInput(data, source),
      onResize: (cols, rows) => callbacks.current.onResize(cols, rows),
      onResizeAnswered: (answer) => callbacks.current.onResizeAnswered(answer),
      onAlternateScreen: (alternate) => callbacks.current.onAlternateScreen(alternate),
      onReadingBack: (readingBack) => callbacks.current.onReadingBack(readingBack),
      onFailure: (error) => callbacks.current.onFailure(error),
    })
    created.setAway(awayNow.current)
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
    mirror.current?.setAway(away)
  }, [away, mirror])

  return <div ref={host} className="companion-terminal-host" />
}

function describeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The terminal could not be shown: ${detail}`
}
