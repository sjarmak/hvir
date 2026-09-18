import type { CompanionClient } from './companion-client'
import { selectedCompanionRow, type CompanionConnection } from './companion-store'
import { PairScreen } from './pair-screen'
import { SessionsList } from './sessions-list'
import { TranscriptView } from './transcript-view'
import { useCompanionSession } from './use-companion-session'

interface CompanionAppProps {
  readonly client: CompanionClient
}

/** The phone page: pair once, then observe the desktop's Sessions and answer. */
export function CompanionApp({ client }: CompanionAppProps) {
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
      {state.transcript === undefined ? (
        <SessionsList rows={state.snapshot?.rows ?? []} onSelect={session.select} />
      ) : (
        <TranscriptView
          row={selectedCompanionRow(state)}
          transcript={state.transcript}
          onBack={session.back}
          onResume={session.resume}
          onRespond={session.respond}
          onSubmit={session.submit}
        />
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
