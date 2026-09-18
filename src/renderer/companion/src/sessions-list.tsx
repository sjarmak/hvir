import type { CompanionRow, SessionsTerminalHandle } from '../../../shared'

interface SessionsListProps {
  readonly rows: readonly CompanionRow[]
  readonly onSelect: (handle: SessionsTerminalHandle) => Promise<void>
}

/** The desktop's ordering, verbatim: actionable rows first, then the rest. */
export function SessionsList({ rows, onSelect }: SessionsListProps) {
  if (rows.length === 0) {
    return <p className="companion-empty">No sessions to show.</p>
  }
  return (
    <ul className="companion-rows">
      {rows.map((row) => (
        <li key={row.handle}>
          <button
            type="button"
            className="companion-row"
            data-handle={row.handle}
            onClick={() => void onSelect(row.handle)}
          >
            <span className="companion-row-title">{row.title}</span>
            <span className="companion-row-meta">
              {row.project.name} / {row.workspace.name}
              {row.workspace.hostKind === 'ssh' ? ` on ${row.workspace.hostLabel}` : ''}
              {row.origin.kind === 'external-agent'
                ? ` via ${row.origin.sourceName}`
                : ''}
            </span>
            <RowBadges row={row} />
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Attention as the actionable set reports it. A stale row says so, with the
 * reason the desktop gave; a row nobody watches says nothing at all.
 */
function RowBadges({ row }: { readonly row: CompanionRow }) {
  const attention =
    (row.attention.status === 'available' || row.attention.status === 'stale') &&
    row.attention.value !== 'none'
      ? row.attention.value
      : undefined
  const turn = row.turn.status === 'available' ? row.turn.value.state : undefined
  if (attention === undefined && row.freshness === 'fresh' && turn === undefined)
    return null
  return (
    <span className="companion-row-badges">
      {attention === undefined ? null : (
        <span
          className={`companion-badge companion-badge-attention companion-badge-${attention}`}
        >
          {attention}
        </span>
      )}
      {row.freshness === 'stale' ? (
        <span className="companion-badge companion-badge-stale">
          unconfirmed ({row.reason ?? 'unknown'})
        </span>
      ) : null}
      {turn === undefined ? null : (
        <span className="companion-badge companion-badge-turn">{turn}</span>
      )}
    </span>
  )
}
