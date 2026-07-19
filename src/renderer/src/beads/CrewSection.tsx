import type { ReactElement } from 'react'

import type { BeadIssue, GasCityCrew, GasCityCrewResponse } from '../../../shared'
import { buildCrewView, type CrewCard, type CrewGroup } from './crew-model'
import {
  GAS_CITY_ACTIONS,
  GAS_CITY_ACTION_HINTS,
  GAS_CITY_ACTION_LABELS,
  type GasCityAction,
} from './gascity-commands'
import './crew.css'

/** Enough names to recognize the pattern; the count carries the rest. */
const UNMATCHED_SHOWN = 3

interface CrewSectionProps {
  readonly response: GasCityCrewResponse | undefined
  /** Open beads for the workspace; used to show what each member is working. */
  readonly issues: readonly BeadIssue[]
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onAction: (action: GasCityAction, target: string) => void
}

/**
 * The rig's crew, pinned above the bead sections: the workspace's permanent
 * lead identities first — rendered even when dormant — then the live worker
 * pools. Every card is clickable into the terminal area and carries the same
 * four gc actions; the tier changes a card's prominence, not what you can do
 * to the session behind it.
 */
export function CrewSection({
  response,
  issues,
  collapsed,
  onToggle,
  onAction,
}: CrewSectionProps): ReactElement | null {
  // A workspace outside a Gas City, or one where gc is not installed, simply has
  // no crew — that is not an error worth a banner in the bead panel.
  if (!response) return null
  if (!response.available) {
    return response.reason === 'error' ? (
      <div className="beads-section crew-section">
        <p className="beads-empty">Crew unavailable: {response.message}</p>
      </div>
    ) : null
  }

  const view = buildCrewView(response, issues)
  if (view.total === 0) return null

  return (
    <div className="beads-section crew-section">
      <button
        type="button"
        className="beads-section-header"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className={`beads-caret${collapsed ? '' : ' expanded'}`}>▸</span>
        <span className="beads-section-label beads-section-crew">Crew</span>
        <span className="crew-scope" title={scopeHint(response.scope)}>
          {response.scope === 'city' ? 'city-wide' : (response.rigName ?? 'this rig')}
        </span>
        <span className="beads-section-count">{view.total}</span>
      </button>
      {collapsed ? null : (
        <>
          {view.leads.map((card) => renderCard(card, true))}
          {view.pools.map((group) => renderPool(group))}
          {view.internals.length > 0
            ? renderPool({ key: 'internals', label: 'orchestration', cards: view.internals })
            : null}
          {renderUnaccounted(response)}
          {response.tierSource === 'config' ? (
            <p className="beads-section-note">
              Tiering derived from the resolved city config; gc does not yet project it.
            </p>
          ) : null}
        </>
      )}
    </div>
  )

  /**
   * Say what the derivation could not account for, rather than rendering a
   * confidently wrong crew. A config read under the wrong key yields zero
   * pinned identities and is otherwise indistinguishable from a city that has
   * none — this is the difference, on screen.
   */
  function renderUnaccounted(crew: GasCityCrew): ReactElement | null {
    const { namedSessions, pinned, unmatched } = crew.diagnostics
    const noPins = crew.tierSource === 'config' && pinned === 0
    if (!noPins && unmatched.length === 0) return null
    return (
      <div className="crew-unaccounted" role="note">
        {noPins ? (
          <p>
            No pinned identities in the resolved config ({namedSessions} named session
            {namedSessions === 1 ? '' : 's'} read). Every session here is shown as a
            worker.
          </p>
        ) : null}
        {unmatched.length > 0 ? (
          <p>
            Unclassified: {unmatched.slice(0, UNMATCHED_SHOWN).join(', ')}
            {unmatched.length > UNMATCHED_SHOWN
              ? ` +${unmatched.length - UNMATCHED_SHOWN}`
              : ''}{' '}
            — no named session or agent describes {unmatched.length === 1 ? 'it' : 'them'}.
          </p>
        ) : null}
      </div>
    )
  }

  function renderPool(group: CrewGroup): ReactElement {
    return (
      <div className="crew-pool" key={group.key}>
        <div className="crew-pool-header">
          <span className="crew-pool-label">{group.label}</span>
          <span className="beads-section-count">{group.cards.length}</span>
        </div>
        <ul className="beads-list">
          {group.cards.map((card) => (
            <li key={card.member.key}>{renderCard(card, false)}</li>
          ))}
        </ul>
      </div>
    )
  }

  function renderCard(card: CrewCard, lead: boolean): ReactElement {
    const { member, bead } = card
    const state = member.session?.state ?? 'not running'
    return (
      <div className={`crew-card${lead ? ' crew-card-lead' : ''}`} key={member.key}>
        <button
          type="button"
          className="crew-card-main"
          title={`Attach to ${member.target}`}
          onClick={() => onAction('attach', member.target)}
        >
          {lead ? <span className="crew-pin" aria-hidden="true">📌</span> : null}
          <span className="crew-name">{member.label}</span>
          <span className={`crew-state crew-state-${stateClass(state)}`}>{state}</span>
          {member.session?.contextPct !== undefined ? (
            <span className="crew-context">{Math.round(member.session.contextPct)}%</span>
          ) : null}
        </button>
        {bead ? (
          <div className="crew-bead" title={bead.title}>
            <span className="crew-bead-title">{bead.title}</span>
            {bead.formula ? <span className="crew-bead-tag">{bead.formula}</span> : null}
            {bead.molecule ? <span className="crew-bead-tag">{bead.molecule}</span> : null}
          </div>
        ) : null}
        <div className="crew-actions">
          {GAS_CITY_ACTIONS.map((action) => (
            <button
              type="button"
              key={action}
              className={`crew-action crew-action-${action}`}
              title={GAS_CITY_ACTION_HINTS[action]}
              onClick={() => onAction(action, member.target)}
            >
              {GAS_CITY_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      </div>
    )
  }
}

function scopeHint(scope: 'city' | 'rig'): string {
  return scope === 'city'
    ? 'Orchestration workspace: every rig’s lead and every active worker'
    : 'Rig workspace: this rig’s crew plus the city’s leads'
}

/**
 * Collapse gc's state vocabulary onto the three the styling distinguishes.
 * Unknown states fall through to `other` rather than being coerced into one of
 * the known ones.
 */
function stateClass(state: string): string {
  if (state === 'active' || state === 'running') return 'active'
  if (state === 'suspended' || state === 'asleep') return 'idle'
  if (state === 'not running') return 'dormant'
  return 'other'
}
