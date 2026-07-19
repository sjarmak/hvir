import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { BeadIssue, BeadsListResponse, HostPath } from '../../../shared'
import {
  classifyBeads,
  priorityLabel,
  type BeadCard,
  type BeadsSection,
  type BeadsView,
  type GateItem,
} from './beads-model'
import { beadDetail, beadSignals } from './bead-card'
import { createVisibilityRefresh } from './beads-refresh'
import './beads.css'

const CHANGED_REFETCH_DELAY_MS = 300
/**
 * Bounded poll period while the panel is visible. Shared-Dolt mutations do not
 * touch the rig's `.beads/` directory, so the file watcher can miss them; a
 * modest visible-only poll keeps the panel current without hammering `bd`.
 */
const VISIBLE_POLL_INTERVAL_MS = 5000
/**
 * Ignore `.beads/` change events for a short window after a refetch completes.
 * Our own `bd` reads (several per refresh: list, ready, gates, edges, jq) can
 * touch `.beads/`, which the watcher then reports as a change — a feedback loop
 * that would refetch continuously. This cooldown breaks that loop while still
 * catching genuine external edits after it, and the visible poll is the backstop.
 */
const CHANGED_COOLDOWN_MS = 2500

interface BeadsPanelProps {
  readonly root: HostPath
  readonly connected: boolean
  readonly hidden?: boolean
  /** Open a terminal attached to a live in-flight worker (`gc session attach …`). */
  readonly onAttachWorker?: (worker: string) => void
}

export function BeadsPanel({
  root,
  connected,
  hidden = false,
  onAttachWorker,
}: BeadsPanelProps): ReactElement {
  const [response, setResponse] = useState<BeadsListResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [showInternals, setShowInternals] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const requestSerial = useRef(0)
  const inFlight = useRef(false)
  const lastCompletedAt = useRef(0)
  const showClosedRef = useRef(showClosed)
  showClosedRef.current = showClosed
  const showInternalsRef = useRef(showInternals)
  showInternalsRef.current = showInternals

  const refresh = useCallback(async (): Promise<void> => {
    // Non-reentrant: a poll tick, focus, or watch event that arrives while a
    // refetch is in flight is dropped rather than overlapped (slow SSH `bd`
    // calls can outlast the 5s poll), so the button never flickers.
    if (inFlight.current) return
    inFlight.current = true
    const serial = ++requestSerial.current
    setLoading(true)
    try {
      const result = await window.hvir.invoke('beads:list', {
        root,
        includeClosed: showClosedRef.current,
        includeInternals: showInternalsRef.current,
      })
      if (serial !== requestSerial.current) return
      setResponse(result)
      setError(undefined)
    } catch (reason) {
      if (serial !== requestSerial.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      lastCompletedAt.current = Date.now()
      if (serial === requestSerial.current) setLoading(false)
    }
  }, [root])

  // Local-change signal: watch `.beads/` and refetch on a debounced burst. This
  // stays subscribed regardless of visibility, but it is a best-effort hint —
  // shared-Dolt mutations happen in the central server and may never touch this
  // directory, which is why the visible-only poll below is the reliable signal.
  useEffect(() => {
    if (!connected) return
    void window.hvir.invoke('beads:watch', { root }).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = window.hvir.on('beads:changed', (event) => {
      if (event.root.hostId !== root.hostId || event.root.path !== root.path) return
      // Suppress the echo of our own reads: a change right after a refetch is
      // almost certainly bd touching `.beads/`, not a real external edit.
      if (Date.now() - lastCompletedAt.current < CHANGED_COOLDOWN_MS) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void refresh()
      }, CHANGED_REFETCH_DELAY_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      void dispose()
      void window.hvir.invoke('beads:unwatch', { root }).catch(() => undefined)
    }
  }, [root, connected, refresh])

  // Visible-only refresh + bounded polling. Refreshes on becoming visible and
  // on regaining focus, polls while visible, and stops the moment the panel is
  // hidden or the component unmounts, so a background panel never drives `bd`.
  useEffect(() => {
    const controller = createVisibilityRefresh({
      onRefresh: () => void refresh(),
      intervalMs: VISIBLE_POLL_INTERVAL_MS,
    })
    controller.setVisible(connected && !hidden)
    const onFocus = (): void => controller.focus()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      controller.dispose()
    }
  }, [connected, hidden, refresh])

  const toggleClosed = (): void => {
    setShowClosed(!showClosed)
    showClosedRef.current = !showClosed
    void refresh()
  }

  const toggleInternals = (): void => {
    setShowInternals(!showInternals)
    showInternalsRef.current = !showInternals
    void refresh()
  }

  const toggleExpanded = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSection = (key: string): void => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="rail-section beads-panel" aria-label="Beads" hidden={hidden}>
      <div className="panel-header beads-header">
        <span className="beads-title">Beads</span>
        <button
          type="button"
          className="beads-refresh"
          title="Refresh beads"
          disabled={loading || !connected}
          onClick={() => void refresh()}
        >
          {loading ? '…' : '⟳'}
        </button>
      </div>
      <div className="beads-body">{renderBody()}</div>
    </section>
  )

  function renderBody(): ReactElement {
    if (error) {
      return <p className="beads-empty">Beads unavailable: {error}</p>
    }
    if (!response) {
      return <p className="beads-empty">{loading ? 'Loading beads…' : 'No data yet.'}</p>
    }
    if (!response.available) {
      return <p className="beads-empty">{response.message}</p>
    }
    const view = classifyBeads(response)
    const empty =
      response.issues.length === 0 &&
      view.gates.length === 0 &&
      view.dataHygiene.length === 0
    return (
      <>
        {empty ? <p className="beads-empty">No open beads.</p> : null}
        {view.sections
          .filter((section) => sectionHasContent(section, view))
          .map((section) => renderSection(section, view))}
        {renderDataHygiene(view.dataHygiene)}
        <div className="beads-toggles">
          <button type="button" aria-pressed={showClosed} onClick={toggleClosed}>
            {showClosed ? 'Hide closed' : 'Show closed'}
          </button>
          <button type="button" aria-pressed={showInternals} onClick={toggleInternals}>
            {showInternals
              ? 'Hide orchestration internals'
              : 'Show orchestration internals'}
          </button>
        </div>
        {showInternals ? renderInternals(view, response.orchestrationIssues ?? []) : null}
        {showClosed && response.closedIssues
          ? renderClosedSection(response.closedIssues)
          : null}
      </>
    )
  }

  function sectionHasContent(section: BeadsSection, view: BeadsView): boolean {
    if (section.key === 'needsYou' && view.gates.length > 0) return true
    return section.count > 0
  }

  function renderSection(section: BeadsSection, view: BeadsView): ReactElement {
    const collapsed = collapsedSections.has(section.key)
    const displayCount =
      section.count + (section.key === 'needsYou' ? view.gates.length : 0)
    return (
      <div className="beads-section" key={section.key}>
        <button
          type="button"
          className="beads-section-header"
          aria-expanded={!collapsed}
          onClick={() => toggleSection(section.key)}
        >
          <span className={`beads-caret${collapsed ? '' : ' expanded'}`}>▸</span>
          <span className={`beads-section-label beads-section-${section.key}`}>
            {section.label}
          </span>
          <span className="beads-section-count">{displayCount}</span>
        </button>
        {collapsed ? null : (
          <>
            {section.note ? <p className="beads-section-note">{section.note}</p> : null}
            {section.key === 'needsYou'
              ? view.gates.map((item) => renderGate(item))
              : null}
            <ul className="beads-list">
              {section.cards.map((card) => renderCard(card))}
            </ul>
            {section.groups?.map((group) => (
              <div className="beads-group" key={group.outcome.id}>
                <div className="beads-group-outcome" title={group.outcome.title}>
                  <span className="beads-group-badge">epic</span>
                  <span className="beads-group-title">{group.outcome.title}</span>
                </div>
                <ul className="beads-list beads-group-list">
                  {group.cards.map((card) => renderCard(card))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    )
  }

  function renderGate(item: GateItem): ReactElement {
    return (
      <div className="beads-gate" key={item.gate.id}>
        <span className="beads-gate-badge">{item.gate.gateType} gate</span>
        <span className="beads-gate-title" title={item.gate.title}>
          {item.gate.title}
        </span>
        {item.blocks ? (
          <span className="beads-gate-unlocks">unblocks {item.blocks.title}</span>
        ) : null}
      </div>
    )
  }

  function renderCard(card: BeadCard): ReactElement {
    const { issue } = card
    const open = expanded.has(issue.id)
    return (
      <li key={issue.id}>
        <button
          type="button"
          className={`beads-row${open ? ' expanded' : ''}`}
          aria-expanded={open}
          onClick={() => toggleExpanded(issue.id)}
        >
          <span className={`beads-priority beads-priority-${issue.priority}`}>
            {priorityLabel(issue.priority)}
          </span>
          <span className="beads-row-title" title={issue.title}>
            {issue.title}
          </span>
          <span className="beads-type">{issue.issueType}</span>
        </button>
        {beadSignals(card, onAttachWorker)}
        {open ? beadDetail(card) : null}
      </li>
    )
  }

  function renderDataHygiene(issues: readonly BeadIssue[]): ReactElement | null {
    if (issues.length === 0) return null
    return (
      <div className="beads-section beads-hygiene" role="alert">
        <div className="beads-hygiene-header">
          <span className="beads-hygiene-badge">⚠</span>
          <span className="beads-section-label">Unclassified ({issues.length})</span>
        </div>
        <p className="beads-hygiene-note">
          Missing typed semantics — not classifiable as executable, blocked, or planned.
          Fix the bead type/metadata rather than guessing from its title.
        </p>
        <ul className="beads-list">
          {issues.map((issue) => (
            <li key={issue.id} className="beads-hygiene-row">
              <span className="beads-row-title" title={issue.title}>
                {issue.title}
              </span>
              <span className="beads-type">{issue.issueType || '(no type)'}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  function renderInternals(
    view: BeadsView,
    orchestration: readonly BeadIssue[],
  ): ReactElement {
    return (
      <div className="beads-section beads-internals">
        <div className="beads-section-header beads-internals-header">
          <span className="beads-section-label">Orchestration internals</span>
          <span className="beads-section-count">{orchestration.length}</span>
        </div>
        <ul className="beads-list">
          {orchestration.map((issue) => (
            <li key={issue.id} className="beads-internals-row">
              <span className="beads-row-title" title={issue.title}>
                {issue.title}
              </span>
              <span className="beads-type">{issue.issueType}</span>
            </li>
          ))}
        </ul>
        <p className="beads-hygiene-note">
          Dependency edges: {view.dependencies.length} · dispatchability source:{' '}
          {view.dispatchabilitySource}
        </p>
      </div>
    )
  }

  function renderClosedSection(issues: readonly BeadIssue[]): ReactElement {
    const collapsed = collapsedSections.has('completed')
    return (
      <div className="beads-section" key="completed">
        <button
          type="button"
          className="beads-section-header"
          aria-expanded={!collapsed}
          onClick={() => toggleSection('completed')}
        >
          <span className={`beads-caret${collapsed ? '' : ' expanded'}`}>▸</span>
          <span className="beads-section-label beads-section-completed">
            Completed recently
          </span>
          <span className="beads-section-count">{issues.length}</span>
        </button>
        {collapsed ? null : (
          <ul className="beads-list">
            {issues.map((issue) =>
              renderCard({ issue, blockedBy: [], unlocksCount: 0, unlocks: [] }),
            )}
          </ul>
        )}
      </div>
    )
  }
}
