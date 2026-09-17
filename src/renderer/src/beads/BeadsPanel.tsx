import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'

import type { BeadIssue, BeadsListResponse, HostPath } from '../../../shared'
import {
  classifyBeads,
  priorityLabel,
  type BeadCard,
  type BeadsSection,
  type BeadsView,
  type GateItem,
} from './beads-model'
import { beadDetail, beadSignals, type BeadTraceScope } from './bead-card'
import { beadStore } from './analytics-links'
import { beadSectionKeys } from './bead-placement'
import type { BeadActionRequest } from './bead-commands'
import { BeadCreateForm } from './bead-create-form'
import { createVisibilityRefresh } from './beads-refresh'
import { CrewSection } from './CrewSection'
import { memberForIdentity } from './crew-model'
import type { GasCityAction } from './gascity-commands'
import { useAnalyticsConfig } from './use-analytics-config'
import { useGasCityCrew } from './use-gascity-crew'
import './beads.css'

const CHANGED_REFETCH_DELAY_MS = 300
/**
 * Bounded poll period while the panel is visible. Shared-Dolt mutations do not
 * touch the rig's `.beads/` directory, so the file watcher can miss them; a
 * modest visible-only poll keeps the panel current without hammering `bd`.
 * Typed bd write actions (claim/close/create) rely on this poll too: the watch
 * is best-effort and the echo cooldown below may swallow their change event.
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
/**
 * One refresh this long after a typed bd write action. The visible poll backs
 * off to as much as 30 s on a slow host, and the watch may miss the change
 * inside the echo cooldown; bd itself finishes in well under this.
 */
const ACTION_REFRESH_DELAY_MS = 1500
/** Shown on every typed action while the workspace terminal cannot open a shell. */
export const LAUNCH_UNAVAILABLE_HINT =
  'No terminal can launch in this workspace (no default harness); the command cannot be typed'

interface BeadsPanelProps {
  readonly root: HostPath
  readonly connected: boolean
  readonly hidden?: boolean
  /** Run a gc action (attach/peek/reset/handoff) against a crew identity. */
  readonly onCrewAction?: (
    action: GasCityAction,
    target: string,
    sessionId?: string,
  ) => void
  /**
   * Type a bd write action (claim/close/create) into the workspace terminal;
   * resolves true once the terminal reports the command was typed.
   */
  readonly onBeadAction?: (request: BeadActionRequest) => Promise<boolean>
  /**
   * Whether the workspace terminal can open a shell for a typed action. When
   * false every crew and bead action is disabled with a hint rather than fired
   * into nothing. Defaults to true for callers that own no terminal.
   */
  readonly canLaunch?: boolean
}

export function BeadsPanel({
  root,
  connected,
  hidden = false,
  onCrewAction,
  onBeadAction,
  canLaunch = true,
}: BeadsPanelProps): ReactElement {
  const launchHint = canLaunch ? undefined : LAUNCH_UNAVAILABLE_HINT
  const [response, setResponse] = useState<BeadsListResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [showInternals, setShowInternals] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(
    new Set(),
  )
  // Owned here, not by the form, so a transient list error that unmounts the
  // form does not discard a half-typed title.
  const [createTitle, setCreateTitle] = useState('')
  const [pendingFocus, setPendingFocus] = useState<string>()
  const rootRef = useRef<HTMLElement>(null)
  const actionRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const requestSerial = useRef(0)
  const inFlight = useRef(false)
  const lastCompletedAt = useRef(0)
  const showClosedRef = useRef(showClosed)
  showClosedRef.current = showClosed
  const showInternalsRef = useRef(showInternals)
  showInternalsRef.current = showInternals
  const crew = useGasCityCrew({
    root,
    connected,
    hidden,
    includeInternals: showInternals,
  })
  const analytics = useAnalyticsConfig(connected && !hidden)
  // The store decides the work-id hash, so no store known means no link.
  const store = beadStore(crew.response?.available === true ? crew.response : undefined)
  const traceScope: BeadTraceScope | undefined =
    analytics?.honeycomb && store !== undefined
      ? { config: analytics.honeycomb, store }
      : undefined
  const placement = useMemo(
    () =>
      response?.available === true
        ? beadSectionKeys(
            classifyBeads(response),
            showClosed ? response.closedIssues : [],
          )
        : new Map<string, string>(),
    [response, showClosed],
  )

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
      onRefresh: () => refresh(),
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

  useEffect(
    () => () => {
      if (actionRefreshTimer.current !== undefined)
        clearTimeout(actionRefreshTimer.current)
    },
    [],
  )

  // Deliver the action and, once the terminal accepted it, schedule exactly one
  // follow-up refresh; a second action inside the window restarts the timer
  // rather than stacking a refresh. A refused action changes nothing in bd, so
  // it earns no refresh.
  const requestBeadAction = async (request: BeadActionRequest): Promise<boolean> => {
    if (!onBeadAction || !canLaunch) return false
    const accepted = await onBeadAction(request)
    if (!accepted) return false
    if (actionRefreshTimer.current !== undefined) clearTimeout(actionRefreshTimer.current)
    actionRefreshTimer.current = setTimeout(() => {
      actionRefreshTimer.current = undefined
      void refresh()
    }, ACTION_REFRESH_DELAY_MS)
    return true
  }

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

  // Open the bead's section and its detail, then scroll once the row exists:
  // the scroll runs from the effect below, after the re-render that mounts it.
  // A bead with no section is not on screen (internals or closed hidden); its
  // chip is already disabled, so this is a no-op by design rather than by luck.
  const focusBead = (id: string): void => {
    const section = placement.get(id)
    if (section === undefined) return
    setCollapsedSections((current) => {
      if (!current.has(section)) return current
      const next = new Set(current)
      next.delete(section)
      return next
    })
    setExpanded((current) => new Set([...current, id]))
    setPendingFocus(id)
  }

  useEffect(() => {
    if (pendingFocus === undefined) return
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-bead-id="${CSS.escape(pendingFocus)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
    setPendingFocus(undefined)
  }, [pendingFocus])

  const toggleSection = (key: string): void => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section
      className="rail-section beads-panel"
      aria-label="Gas City"
      hidden={hidden}
      ref={rootRef}
    >
      <div className="panel-header beads-header">
        <span className="beads-title">Gas City</span>
        <button
          type="button"
          className="beads-refresh"
          title="Refresh crew and beads"
          disabled={loading || !connected}
          onClick={() => {
            void refresh()
            crew.refresh()
          }}
        >
          {loading ? '…' : '⟳'}
        </button>
      </div>
      <div className="beads-body">
        {renderCrew()}
        {renderBody()}
      </div>
    </section>
  )

  // The crew is rendered outside `renderBody` on purpose: a `bd` failure must
  // not also hide who is running in the rig — that is exactly when you want to
  // see it. It joins against whatever beads did load, or none.
  function renderCrew(): ReactElement | null {
    if (!onCrewAction) return null
    return (
      <CrewSection
        response={crew.response}
        issues={response?.available === true ? response.issues : []}
        collapsed={collapsedSections.has('crew')}
        onToggle={() => toggleSection('crew')}
        onAction={onCrewAction}
        {...(launchHint === undefined ? {} : { actionsDisabledHint: launchHint })}
        onSelectBead={focusBead}
        renderedBeadIds={new Set(placement.keys())}
        analytics={analytics}
      />
    )
  }

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
        {onBeadAction ? (
          <BeadCreateForm
            value={createTitle}
            onChange={setCreateTitle}
            onCreate={(title) => requestBeadAction({ action: 'create', title })}
            {...(launchHint === undefined ? {} : { disabledHint: launchHint })}
          />
        ) : null}
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

  // A bead names its owner, not a session. Resolving that name against the
  // crew's identity keys is exact when a single member claims it, and that is
  // what lets the terminal this opens be recognized later as the one showing
  // the session. A contested or unknown name still attaches; it just carries no
  // join, because guessing one from the label would be worse than none.
  function attachWorker(worker: string): void {
    if (!onCrewAction) return
    const members = crew.response?.available === true ? crew.response.members : []
    onCrewAction('attach', worker, memberForIdentity(members, worker)?.session?.id)
  }

  function renderCard(card: BeadCard): ReactElement {
    const { issue } = card
    const open = expanded.has(issue.id)
    return (
      <li key={issue.id} data-bead-id={issue.id}>
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
        {beadSignals(
          card,
          onCrewAction && ((worker) => attachWorker(worker)),
          traceScope,
        )}
        {open
          ? beadDetail(
              card,
              onBeadAction && ((request) => void requestBeadAction(request)),
              launchHint,
            )
          : null}
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
