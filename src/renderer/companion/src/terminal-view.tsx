import { useEffect, useRef, useState } from 'react'

import type {
  CompanionResizeResponse,
  CompanionRow,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import type { CompanionMirrorFeed } from './companion-mirror-feed'
import { companionMirrorEndMessage, type CompanionTerminalState } from './companion-store'
import { CompanionTerminalMount } from './companion-terminal-mount'
import type { CompanionTerminalPaneFactory } from './companion-terminal-pane'
import { MirrorControls } from './mirror-controls'
import { MirrorHeader } from './mirror-header'
import { TranscriptView } from './transcript-view'
import type { CompanionInputArmingControl } from './use-input-arming'

type ResizeVerb = (
  cols: number,
  rows: number,
) => Promise<CompanionResizeResponse | undefined>

interface TerminalViewProps {
  readonly row: CompanionRow | undefined
  readonly terminal: CompanionTerminalState
  readonly transcript: SessionsTranscriptSnapshot | undefined
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly arming: CompanionInputArmingControl
  /** The snapshot's word on the desktop's focus; the pane asks for its size only while Away. */
  readonly away: boolean
  readonly onInput: (data: string) => Promise<void>
  readonly onResize: ResizeVerb
  readonly onBack: () => void
  readonly onResume: () => Promise<void>
  readonly onRespond: (optionOrdinal: number) => Promise<void>
  readonly onSubmit: (message: string) => Promise<boolean>
}

/** The Away door said no (ADR-052): a status, not an error; the scaled mirror stays. */
const DESKTOP_KEEPS_SIZE = 'The desktop is focused, so it keeps the terminal size.'

/**
 * One mirrored terminal (ADR-050) filling the phone's screen: a one-line
 * header, the terminal in all the height that remains (the desktop's grid
 * scaled to the phone's width, its scrollback drawn above it, or the phone's
 * own grid unscaled while it holds the size), and one compact control bar at
 * the bottom. While the row carries a prompt, its message is the header's
 * second line (ADR-051). A row that also takes answers offers its transcript
 * beside the mirror.
 */
export function TerminalView(props: TerminalViewProps) {
  const { row, terminal, transcript, arming, onInput, onResize } = props
  const [showTranscript, setShowTranscript] = useState(false)
  const [paneFailure, setPaneFailure] = useState<string>()
  const [sizeStatus, setSizeStatus] = useState<string>()
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
  const requestSize = async (cols: number, rows: number): Promise<void> => {
    const outcome = await onResize(cols, rows)
    setSizeStatus(outcome?.outcome === 'refused' ? DESKTOP_KEEPS_SIZE : undefined)
  }
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
          onInput={onInput}
          onResize={requestSize}
          onFailure={(error) => setPaneFailure(describeFailure(error))}
        />
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
  away,
  onInput,
  onResize,
  onFailure,
}: {
  readonly handle: SessionsTerminalHandle
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly inputEnabled: boolean
  readonly away: boolean
  readonly onInput: (data: string) => Promise<void>
  readonly onResize: (cols: number, rows: number) => Promise<void>
  readonly onFailure: (error: unknown) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<CompanionTerminalMount>(undefined)
  const callbacks = useRef({ onInput, onResize, onFailure })
  callbacks.current = { onInput, onResize, onFailure }

  useEffect(() => {
    const element = host.current
    if (element === null) return
    const created = new CompanionTerminalMount({
      host: element,
      createPane,
      onInput: (data) => void callbacks.current.onInput(data),
      onResize: (cols, rows) => void callbacks.current.onResize(cols, rows),
      onFailure: (error) => callbacks.current.onFailure(error),
    })
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

  useEffect(() => {
    mount.current?.setAway(away)
  }, [away])

  return <div ref={host} className="companion-terminal-host" />
}

function describeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The terminal could not be shown: ${detail}`
}
