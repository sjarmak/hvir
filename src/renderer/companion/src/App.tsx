import type { CompanionClient } from './companion-client'
import { selectedCompanionRow, type CompanionConnection } from './companion-store'
import type { CompanionTerminalPaneFactory } from './companion-terminal-pane'
import { PairScreen } from './pair-screen'
import { SessionsList } from './sessions-list'
import { TerminalView } from './terminal-view'
import { TranscriptView } from './transcript-view'
import { useCompanionSession } from './use-companion-session'

interface CompanionAppProps {
  readonly client: CompanionClient
  /** Builds the emulator pane for a mirror; the page never constructs one itself. */
  readonly createPane: CompanionTerminalPaneFactory
}

/** The phone page: pair once, then observe the desktop's Sessions and answer. */
export function CompanionApp({ client, createPane }: CompanionAppProps) {
  const session = useCompanionSession(client)
  if (session.connection.phase === 'unpaired') {
    return <PairScreen error={session.connection.error} onPair={session.pair} />
  }
  const { state } = session
  return (
    <main className="companion">
      <ConnectionBanner connection={session.connection} onReconnect={session.reconnect} />
      {session.notice === undefined ? null : (
        <p className="companion-error" role="alert">
          {session.notice}
        </p>
      )}
      {state.terminal !== undefined ? (
        <TerminalView
          row={selectedCompanionRow(state)}
          terminal={state.terminal}
          transcript={state.transcript}
          feed={session.feed}
          createPane={createPane}
          arming={session.arming}
          away={state.snapshot?.away ?? false}
          onInput={session.input}
          onResize={session.resize}
          onBack={session.back}
          onResume={session.resume}
          onRespond={session.respond}
          onSubmit={session.submit}
        />
      ) : state.transcript !== undefined ? (
        <TranscriptView
          row={selectedCompanionRow(state)}
          transcript={state.transcript}
          onBack={session.back}
          onResume={session.resume}
          onRespond={session.respond}
          onSubmit={session.submit}
        />
      ) : (
        <SessionsList rows={state.snapshot?.rows ?? []} onSelect={session.select} />
      )}
    </main>
  )
}

function ConnectionBanner({
  connection,
  onReconnect,
}: {
  readonly connection: CompanionConnection
  readonly onReconnect: () => void
}) {
  if (connection.phase === 'connecting') {
    return <p className="companion-connection">Connecting to the desktop</p>
  }
  if (connection.phase === 'disconnected') {
    return (
      <div className="companion-connection companion-disconnected" role="status">
        <span>Disconnected: {connection.detail}</span>
        <button type="button" className="companion-button" onClick={onReconnect}>
          Reconnect
        </button>
      </div>
    )
  }
  return null
}
