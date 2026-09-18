import { useEffect, useRef, useState } from 'react'

import type {
  CompanionRow,
  SessionsTerminalHandle,
  SessionsTranscriptSnapshot,
} from '../../../shared'
import type { CompanionMirrorFeed } from './companion-mirror-feed'
import type { CompanionMirrorZoom } from './companion-mirror-zoom'
import { companionMirrorEndMessage, type CompanionTerminalState } from './companion-store'
import { CompanionTerminalMount } from './companion-terminal-mount'
import type { CompanionTerminalPaneFactory } from './companion-terminal-pane'
import { MirrorControls } from './mirror-controls'
import { MirrorHeader } from './mirror-header'
import { TranscriptView } from './transcript-view'
import type { CompanionInputArmingControl } from './use-input-arming'
import { useMirrorZoom } from './use-mirror-zoom'

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
 * One mirrored terminal (ADR-050) filling the phone's screen: a one-line
 * header, the terminal in all the height that remains (the desktop's output
 * reflowed to the phone's width, or its grid scaled), and one compact control
 * bar at the bottom. While the row carries a prompt, its message is the
 * header's second line (ADR-051). A row that also takes answers offers its
 * transcript beside the mirror.
 */
export function TerminalView(props: TerminalViewProps) {
  const { row, terminal, transcript, arming, onInput } = props
  const [showTranscript, setShowTranscript] = useState(false)
  const [paneFailure, setPaneFailure] = useState<string>()
  const { zoom, toggle: toggleZoom } = useMirrorZoom()
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
        zoom={zoom}
        offersTranscript={row?.canAnswer === true && transcript !== undefined}
        onBack={props.onBack}
        onTranscript={() => setShowTranscript(true)}
        onZoom={toggleZoom}
      />
      <div className="companion-terminal-area">
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
          inputEnabled={arming.armed}
          zoom={zoom}
          onInput={onInput}
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
  zoom,
  onInput,
  onFailure,
}: {
  readonly handle: SessionsTerminalHandle
  readonly feed: CompanionMirrorFeed
  readonly createPane: CompanionTerminalPaneFactory
  readonly inputEnabled: boolean
  readonly zoom: CompanionMirrorZoom
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

  useEffect(() => {
    mount.current?.setZoom(zoom)
  }, [zoom])

  return <div ref={host} className="companion-terminal-host" data-zoom={zoom} />
}

function describeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The terminal could not be shown: ${detail}`
}
