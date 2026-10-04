import type { CompanionRow, SessionsTerminalHandle } from '../../../shared'
import {
  companionGroupTitle,
  sectionCompanionRows,
  type CompanionRowGroup,
} from './companion-row-groups'

interface SessionsListProps {
  readonly rows: readonly CompanionRow[]
  readonly onSelect: (handle: SessionsTerminalHandle) => Promise<void>
}

/**
 * One group per workspace, each headed by its project and workspace; inside a
 * group the desktop's ordering, verbatim: actionable rows first, then the rest.
 */
export function SessionsList({ rows, onSelect }: SessionsListProps) {
  if (rows.length === 0) {
    return <p className="companion-empty">No sessions to show.</p>
  }
  const sections = sectionCompanionRows(rows)
  return (
    <div className="companion-groups">
      {sections.workspaceGroups.map((group) => (
        <WorkspaceGroup key={group.key} group={group} onSelect={onSelect} />
      ))}
      {sections.transcriptRows.length === 0 ? null : (
        <TranscriptRows rows={sections.transcriptRows} onSelect={onSelect} />
      )}
    </div>
  )
}

function WorkspaceGroup({
  group,
  onSelect,
}: {
  readonly group: CompanionRowGroup
  readonly onSelect: SessionsListProps['onSelect']
}) {
  return (
    <section className="companion-group" data-workspace={group.key}>
      <h2 className="companion-group-title">{companionGroupTitle(group)}</h2>
      <RowList rows={group.rows} onSelect={onSelect} />
    </section>
  )
}

function TranscriptRows({
  rows,
  onSelect,
}: {
  readonly rows: readonly CompanionRow[]
  readonly onSelect: SessionsListProps['onSelect']
}) {
  return (
    <details className="companion-transcripts" open={rows.some(rowNeedsAttention)}>
      <summary>Transcripts ({rows.length})</summary>
      <RowList rows={rows} onSelect={onSelect} />
    </details>
  )
}

function RowList({
  rows,
  onSelect,
}: {
  readonly rows: readonly CompanionRow[]
  readonly onSelect: SessionsListProps['onSelect']
}) {
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
            {row.promptBody === undefined ? null : (
              <span className="companion-row-prompt">
                <span className="companion-visually-hidden">Prompt: </span>
                {row.promptBody}
              </span>
            )}
            {row.origin.kind === 'external-agent' ? (
              <span className="companion-row-meta">via {row.origin.sourceName}</span>
            ) : null}
            <RowBadges row={row} />
          </button>
        </li>
      ))}
    </ul>
  )
}

function rowNeedsAttention(row: CompanionRow): boolean {
  return row.freshness === 'stale' || actionableAttention(row) !== undefined
}

function actionableAttention(row: CompanionRow) {
  return (row.attention.status === 'available' || row.attention.status === 'stale') &&
    row.attention.value !== 'none'
    ? row.attention.value
    : undefined
}

/**
 * Attention as the actionable set reports it. A stale row says so, with the
 * reason the desktop gave; a row nobody watches says nothing at all. A prompt's
 * message sits under the title, not in the badge (ADR-951). A row is working
 * when a window sees its terminal working or its source says the turn is,
 * and either way the word appears once.
 */
function RowBadges({ row }: { readonly row: CompanionRow }) {
  const attention = actionableAttention(row)
  const turn = row.turn.status === 'available' ? row.turn.value.state : undefined
  const working = row.working || turn === 'working'
  const otherTurn = turn === 'working' ? undefined : turn
  if (
    attention === undefined &&
    row.freshness === 'fresh' &&
    !working &&
    otherTurn === undefined
  ) {
    return null
  }
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
      {working ? (
        <span className="companion-badge companion-badge-working">working</span>
      ) : null}
      {otherTurn === undefined ? null : (
        <span className="companion-badge companion-badge-turn">{otherTurn}</span>
      )}
    </span>
  )
}
