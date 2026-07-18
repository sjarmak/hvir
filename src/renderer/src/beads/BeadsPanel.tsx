import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { BeadIssue, BeadsListResponse, HostPath } from '../../../shared'
import { groupBeads, priorityLabel, type BeadsSectionKey } from './beads-model'
import './beads.css'

const CHANGED_REFETCH_DELAY_MS = 300

interface BeadsPanelProps {
  readonly root: HostPath
  readonly connected: boolean
  readonly hidden?: boolean
}

export function BeadsPanel({
  root,
  connected,
  hidden = false,
}: BeadsPanelProps): ReactElement {
  const [response, setResponse] = useState<BeadsListResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const requestSerial = useRef(0)
  const showClosedRef = useRef(showClosed)
  showClosedRef.current = showClosed

  const refresh = useCallback(
    async (includeClosed: boolean): Promise<void> => {
      const serial = ++requestSerial.current
      setLoading(true)
      try {
        const result = await window.hvir.invoke('beads:list', { root, includeClosed })
        if (serial !== requestSerial.current) return
        setResponse(result)
        setError(undefined)
      } catch (reason) {
        if (serial !== requestSerial.current) return
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (serial === requestSerial.current) setLoading(false)
      }
    },
    [root],
  )

  useEffect(() => {
    if (!connected) return
    void refresh(showClosedRef.current)
    void window.hvir.invoke('beads:watch', { root }).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = window.hvir.on('beads:changed', (event) => {
      if (event.root.hostId !== root.hostId || event.root.path !== root.path) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void refresh(showClosedRef.current)
      }, CHANGED_REFETCH_DELAY_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      void dispose()
      void window.hvir.invoke('beads:unwatch', { root }).catch(() => undefined)
    }
  }, [root, connected, refresh])

  const toggleClosed = (): void => {
    const next = !showClosed
    setShowClosed(next)
    void refresh(next)
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
          onClick={() => void refresh(showClosed)}
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
    const sections = groupBeads(response.issues, response.readyIds)
    const empty = response.issues.length === 0
    return (
      <>
        {empty ? <p className="beads-empty">No open beads.</p> : null}
        {sections
          .filter((section) => section.issues.length > 0)
          .map((section) => renderSection(section.key, section.label, section.issues))}
        <div className="beads-closed-toggle">
          <button type="button" onClick={toggleClosed}>
            {showClosed ? 'Hide closed' : 'Show closed'}
          </button>
        </div>
        {showClosed && response.closedIssues
          ? renderSection('closed', 'Closed', response.closedIssues)
          : null}
      </>
    )
  }

  function renderSection(
    key: BeadsSectionKey | 'closed',
    label: string,
    issues: readonly BeadIssue[],
  ): ReactElement {
    const collapsed = collapsedSections.has(key)
    return (
      <div className="beads-section" key={key}>
        <button
          type="button"
          className="beads-section-header"
          aria-expanded={!collapsed}
          onClick={() => toggleSection(key)}
        >
          <span className={`beads-caret${collapsed ? '' : ' expanded'}`}>▸</span>
          <span className={`beads-section-label beads-section-${key}`}>{label}</span>
          <span className="beads-section-count">{issues.length}</span>
        </button>
        {collapsed ? null : (
          <ul className="beads-list">{issues.map((issue) => renderIssue(issue))}</ul>
        )}
      </div>
    )
  }

  function renderIssue(issue: BeadIssue): ReactElement {
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
        {open ? renderDetail(issue) : null}
      </li>
    )
  }

  function renderDetail(issue: BeadIssue): ReactElement {
    return (
      <div className="beads-detail">
        <div className="beads-detail-meta">
          <span className="beads-id">{issue.id}</span>
          {issue.assignee ? <span>assignee: {issue.assignee}</span> : null}
          {issue.parent ? <span>parent: {issue.parent}</span> : null}
          {issue.dependencyCount > 0 ? <span>deps: {issue.dependencyCount}</span> : null}
          {issue.labels.length > 0 ? <span>{issue.labels.join(', ')}</span> : null}
          {issue.updatedAt ? <span>updated {formatDate(issue.updatedAt)}</span> : null}
          {issue.closedAt ? <span>closed {formatDate(issue.closedAt)}</span> : null}
        </div>
        {renderField('Description', issue.description)}
        {renderField('Design', issue.design)}
        {renderField('Acceptance criteria', issue.acceptanceCriteria)}
        {renderField('Notes', issue.notes)}
        {renderField('Close reason', issue.closeReason)}
      </div>
    )
  }

  function renderField(label: string, value: string | undefined): ReactElement | null {
    if (!value) return null
    return (
      <div className="beads-field">
        <span className="beads-field-label">{label}</span>
        <p className="beads-field-value">{value}</p>
      </div>
    )
  }
}

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}
