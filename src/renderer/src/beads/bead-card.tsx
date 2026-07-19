import type { ReactElement } from 'react'

import type { BeadCard } from './beads-model'

/**
 * Presentation for a single bead card's signals and expanded detail. Split out
 * of `BeadsPanel` so the panel owns list state (expansion, sections, polling)
 * while the per-card rendering — which depends only on the card and the
 * attach-worker callback — lives here.
 */

/** Compact per-card signals: parent outcome, liveness, blockers, unlocks. */
export function beadSignals(
  card: BeadCard,
  onAttachWorker?: (worker: string) => void,
): ReactElement | null {
  const { issue } = card
  const bits: ReactElement[] = []
  if (card.shipState) {
    bits.push(
      <span className="beads-shipstate" key="ship">
        {card.shipState}
      </span>,
    )
  }
  if (card.parentOutcome) {
    bits.push(
      <span className="beads-parent" key="parent" title={card.parentOutcome.title}>
        ↳ {card.parentOutcome.title}
      </span>,
    )
  }
  if (card.liveness) {
    bits.push(
      <span className={`beads-liveness beads-liveness-${card.liveness}`} key="live">
        {livenessLabel(card.liveness)}
      </span>,
    )
  }
  if (card.owner) {
    const owner = card.owner
    const elapsed =
      issue.status === 'in_progress' && issue.updatedAt
        ? ` · ${elapsedSince(issue.updatedAt)}`
        : ''
    // A live/stale in-flight worker can be attached to: click opens a terminal
    // running `gc session attach <worker>` so you can watch what it's doing.
    bits.push(
      onAttachWorker && card.liveness ? (
        <button
          type="button"
          className="beads-owner beads-owner-attach"
          key="owner"
          title={`Attach to ${owner} (gc session attach)`}
          onClick={() => onAttachWorker(owner)}
        >
          @{owner}
          {elapsed}
        </button>
      ) : (
        <span className="beads-owner" key="owner">
          @{owner}
          {elapsed}
        </span>
      ),
    )
  }
  if (card.blockedBy.length > 0) {
    bits.push(
      <span className="beads-blockedby" key="blocked">
        Blocked by: {card.blockedBy[0]?.title}
        {card.blockedBy.length > 1 ? ` +${card.blockedBy.length - 1}` : ''}
      </span>,
    )
  }
  if (card.unlocksCount > 0) {
    bits.push(
      <span className="beads-unlocks" key="unlocks">
        Unlocks {card.unlocksCount}
      </span>,
    )
  }
  if (bits.length === 0) return null
  return <div className="beads-signals">{bits}</div>
}

export function beadDetail(card: BeadCard): ReactElement {
  const { issue } = card
  return (
    <div className="beads-detail">
      <div className="beads-detail-meta">
        <span className="beads-id">{issue.id}</span>
        {card.parentOutcome ? <span>parent: {card.parentOutcome.title}</span> : null}
        {issue.labels.length > 0 ? <span>{issue.labels.join(', ')}</span> : null}
        {issue.updatedAt ? <span>updated {formatDate(issue.updatedAt)}</span> : null}
        {issue.closedAt ? <span>closed {formatDate(issue.closedAt)}</span> : null}
      </div>
      {card.nextUnblock ? (
        <div className="beads-field">
          <span className="beads-field-label">Next unblock</span>
          <p className="beads-field-value">
            {card.nextUnblock.action}
            {card.nextUnblock.owner ? ` — ${card.nextUnblock.owner}` : ''}
          </p>
        </div>
      ) : null}
      {card.blockedBy.length > 0 ? (
        <div className="beads-field">
          <span className="beads-field-label">Blocked by</span>
          <ul className="beads-deplist">
            {card.blockedBy.map((dep) => (
              <li key={dep.id}>
                {dep.title} <span className="beads-dep-state">({dep.status})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.unlocks.length > 0 ? (
        <div className="beads-field">
          <span className="beads-field-label">Unlocks {card.unlocksCount}</span>
          <ul className="beads-deplist">
            {card.unlocks.map((dep) => (
              <li key={dep.id}>{dep.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {beadField('Description', issue.description)}
      {beadField('Design', issue.design)}
      {beadField('Acceptance criteria', issue.acceptanceCriteria)}
      {beadField('Notes', issue.notes)}
      {beadField('Close reason', issue.closeReason)}
    </div>
  )
}

function beadField(label: string, value: string | undefined): ReactElement | null {
  if (!value) return null
  return (
    <div className="beads-field">
      <span className="beads-field-label">{label}</span>
      <p className="beads-field-value">{value}</p>
    </div>
  )
}

function livenessLabel(liveness: 'live' | 'stale' | 'unknown'): string {
  if (liveness === 'live') return 'live'
  if (liveness === 'stale') return 'may be stale'
  return 'liveness unknown'
}

function elapsedSince(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const ms = Date.now() - then
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours < 1) return '<1h'
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}
