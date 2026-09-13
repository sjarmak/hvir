import type { ReactElement } from 'react'

import type {
  BeadIssue,
  GasCityAnalyticsConfig,
  GasCityCrew,
  GasCityCrewResponse,
} from '../../../shared'
import { agentName, omniAnalyticsUrl, sessionTraceUrl, traceLinkTitle } from './analytics-links'
import { buildCrewView, type CrewCard, type CrewGroup, type HeldBead } from './crew-model'
import {
  GAS_CITY_ACTIONS,
  GAS_CITY_ACTION_HINTS,
  GAS_CITY_ACTION_LABELS,
  type GasCityAction,
} from './gascity-commands'
import './crew.css'

/** Enough names to recognize the pattern; the count carries the rest. */
const UNMATCHED_SHOWN = 3
/** Held beads shown per card before the count takes over. */
const HELD_SHOWN = 4

interface CrewSectionProps {
  readonly response: GasCityCrewResponse | undefined
  /** Open beads for the workspace; used to show what each member is working. */
  readonly issues: readonly BeadIssue[]
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onAction: (action: GasCityAction, target: string) => void
  /** Focus a held bead's row in the bead sections; held chips are inert without it. */
  readonly onSelectBead?: (beadId: string) => void
  /**
   * Ids the bead sections currently render. A held bead outside this set has no
   * row to focus (closed or internals hidden), so its chip is disabled and says
   * so. Absent, every chip is focusable.
   */
  readonly renderedBeadIds?: ReadonlySet<string>
  /** Where the Trace and Analytics links point; a missing surface renders no link. */
  readonly analytics?: GasCityAnalyticsConfig
}

const OMNI_HINT =
  'Omni: Gas City Analytics (Neon marts, read-only; refreshed by the factory-analytics ' +
  'order, read the snapshot provenance tile for the source window)'

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
  onSelectBead,
  renderedBeadIds,
  analytics,
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
  // Only a rig-scoped crew has a rig to filter on. A city-scoped response still
  // carries the HQ rig it was resolved from, which would filter every member on
  // the wrong rig, so the city view links nowhere.
  const rig = response.scope === 'rig' ? response.rigName : undefined

  return (
    <div className="beads-section crew-section">
      <div className="crew-header-row">
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
        {analytics?.omni && rig !== undefined ? (
          <a
            className="crew-analytics"
            href={omniAnalyticsUrl(analytics.omni, rig)}
            target="_blank"
            rel="noopener noreferrer"
            title={OMNI_HINT}
          >
            Analytics
          </a>
        ) : null}
      </div>
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
      <div
        className={`crew-card${lead ? ' crew-card-lead' : ''}${
          member.cityLead === true ? ' crew-card-city' : ''
        }`}
        key={member.key}
      >
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
        {card.held.length > 0 ? renderHeld(card.held) : null}
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
          {renderTrace(card)}
        </div>
      </div>
    )
  }

  function renderHeld(held: readonly HeldBead[]): ReactElement {
    return (
      <div className="crew-held" role="list">
        {held.slice(0, HELD_SHOWN).map((bead) => {
          const hidden = renderedBeadIds !== undefined && !renderedBeadIds.has(bead.id)
          return (
            <span className="crew-held-item" role="listitem" key={bead.id}>
              <button
                type="button"
                className={`crew-held-bead${bead.inFlight ? ' crew-held-inflight' : ''}`}
                title={
                  hidden
                    ? `${bead.id}: ${bead.title} (hidden by the current filters)`
                    : `${bead.id}: ${bead.title}`
                }
                disabled={onSelectBead === undefined || hidden}
                onClick={() => onSelectBead?.(bead.id)}
              >
                <span className="crew-held-id">{bead.id}</span>
                <span className="crew-held-title">{bead.title}</span>
              </button>
            </span>
          )
        })}
        {held.length > HELD_SHOWN ? (
          <span className="crew-held-more">+{held.length - HELD_SHOWN}</span>
        ) : null}
      </div>
    )
  }

  /**
   * The member's Honeycomb link, as a plain anchor: the main window routes
   * every window-open to the OS browser. Absent when the name could not have
   * been exported, so no link ever opens a query gas-city cannot match. The
   * rig gc projects on the session wins over the workspace rig; the city lead
   * shown inside a rig workspace exports under the HQ rig, which the response
   * does not name, so it gets no link unless gc projects its rig.
   */
  function renderTrace({ member }: CrewCard): ReactElement | null {
    if (!analytics?.honeycomb || !member.session) return null
    const memberRig = member.session.rig ?? (member.cityLead === true ? undefined : rig)
    if (memberRig === undefined) return null
    const href = sessionTraceUrl(analytics.honeycomb, memberRig, member.session)
    if (href === undefined) return null
    return (
      <a
        className="crew-action crew-action-trace"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={traceLinkTitle(agentName(memberRig, member.session) ?? member.label)}
      >
        Trace
      </a>
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
