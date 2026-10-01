import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { HostPath, PullSummary, PullsResponse } from '../../../shared'
import { createVisibilityRefresh, type VisibilityRefresh } from '../beads/beads-refresh'
import {
  checksLabel,
  pullSections,
  reviewLabel,
  unavailableHint,
  type PullSection,
} from './pulls-model'

import type { PullCheckoutsResponse } from '../../../shared/github'
import { PullWorkspaceAction } from './PullWorkspaceAction'
import type { PullWorkspaceNavigation } from './pull-workspaces'

import './pulls.css'

const VISIBLE_POLL_INTERVAL_MS = 60_000
const SLOW_HOST_POLL_CEILING_MS = 300_000

export interface PullsPanelProps {
  readonly root: HostPath
  readonly connected: boolean
  readonly hidden?: boolean
  readonly navigation?: PullWorkspaceNavigation
}

export function PullsPanel({
  root,
  connected,
  hidden = false,
  navigation,
}: PullsPanelProps): ReactElement {
  const [response, setResponse] = useState<PullsResponse>()
  const [checkouts, setCheckouts] = useState<PullCheckoutsResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const requestSerial = useRef(0)
  const refreshController = useRef<VisibilityRefresh | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const serial = ++requestSerial.current
    setLoading(true)
    try {
      const [result, checkoutResult] = await Promise.all([
        window.hvir.invoke('github:pulls', { root }),
        window.hvir.invoke('github:checkouts', { root }).catch((reason: unknown) => ({
          available: false as const,
          message: reason instanceof Error ? reason.message : String(reason),
        })),
      ])
      if (serial !== requestSerial.current) return
      setResponse(result)
      setCheckouts(checkoutResult)
      setError(undefined)
    } catch (reason) {
      if (serial !== requestSerial.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (serial === requestSerial.current) setLoading(false)
    }
  }, [root])

  useEffect(() => {
    const controller = createVisibilityRefresh({
      onRefresh: refresh,
      intervalMs: VISIBLE_POLL_INTERVAL_MS,
      maxIntervalMs: SLOW_HOST_POLL_CEILING_MS,
    })
    refreshController.current = controller
    return () => {
      controller.dispose()
      refreshController.current = undefined
      requestSerial.current += 1
    }
  }, [refresh])

  useEffect(() => {
    const controller = refreshController.current
    const updateVisibility = (): void => {
      controller?.setVisible(
        connected && !hidden && document.visibilityState !== 'hidden',
      )
    }
    const onFocus = (): void => controller?.focus()
    updateVisibility()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [connected, hidden, refresh])

  return (
    <section
      className="rail-section pulls-panel"
      aria-label="Pull requests"
      hidden={hidden}
    >
      <div className="panel-header pulls-header">
        <span className="pulls-title">Pull requests</span>
        {response?.available === true ? (
          <span className="pulls-repo" title={response.repo}>
            {response.repo}
          </span>
        ) : null}
        <button
          type="button"
          className="pulls-refresh"
          title="Refresh pull requests"
          disabled={loading || !connected}
          onClick={() => refreshController.current?.request()}
        >
          {loading ? '…' : '⟳'}
        </button>
      </div>
      <div className="pulls-body">{renderBody()}</div>
    </section>
  )

  function renderBody(): ReactElement {
    if (error !== undefined) {
      return <p className="pulls-empty">Pull requests unavailable: {error}</p>
    }
    if (response === undefined) {
      return (
        <p className="pulls-empty">
          {loading ? 'Loading pull requests…' : 'No data yet.'}
        </p>
      )
    }
    if (!response.available) {
      return (
        <div className="pulls-empty" role="status">
          <p>{unavailableHint(response)}</p>
          <p className="pulls-detail">{response.message}</p>
        </div>
      )
    }
    const sections = pullSections(response)
    const branchNote =
      response.branch === undefined
        ? 'Detached HEAD, so no branch pull request.'
        : `No pull request for ${response.branch}.`
    return (
      <>
        {sections.map((section) =>
          section.key === 'branch' || section.pulls.length > 0
            ? renderSection(section, section.key === 'branch' ? branchNote : undefined)
            : null,
        )}
        {sections.every((section) => section.pulls.length === 0) ? (
          <p className="pulls-empty">Nothing open that is yours or waiting on you.</p>
        ) : null}
      </>
    )
  }

  function renderSection(
    section: PullSection,
    emptyNote: string | undefined,
  ): ReactElement {
    return (
      <div className="pulls-section" key={section.key}>
        <div className="pulls-section-header">
          <span className="pulls-section-label">{section.label}</span>
          <span className="pulls-section-count">{section.pulls.length}</span>
        </div>
        {section.pulls.length === 0 && emptyNote !== undefined ? (
          <p className="pulls-section-note">{emptyNote}</p>
        ) : (
          <ul className="pulls-list">
            {section.pulls.map((pull) => (
              <li key={pull.number}>{renderPull(pull, section.key === 'review')}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  function renderPull(pull: PullSummary, showAuthor: boolean): ReactElement {
    const checks = checksLabel(pull.checks)
    const review = reviewLabel(pull.review)
    return (
      <div className="pulls-row" data-pull-number={pull.number}>
        <a
          className="pulls-link"
          href={pull.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${pull.headRef} · open on GitHub`}
        >
          <span className="pulls-line">
            <span className="pulls-number">#{pull.number}</span>
            <span className="pulls-row-title">{pull.title}</span>
          </span>
          <span className="pulls-badges">
            {pull.state !== 'open' ? (
              <span className={`pulls-badge pulls-state-${pull.state}`}>
                {pull.state}
              </span>
            ) : null}
            {pull.draft ? <span className="pulls-badge">draft</span> : null}
            {checks !== '' ? (
              <span className={`pulls-badge pulls-checks-${pull.checks}`}>{checks}</span>
            ) : null}
            {review !== '' ? (
              <span className={`pulls-badge pulls-review-${pull.review}`}>{review}</span>
            ) : null}
            {pull.openFeedback > 0 ? (
              <span className="pulls-badge pulls-feedback">
                {pull.openFeedback} open{' '}
                {pull.openFeedback === 1 ? 'comment' : 'comments'}
              </span>
            ) : null}
            {showAuthor && pull.author !== '' ? (
              <span className="pulls-author">@{pull.author}</span>
            ) : null}
          </span>
        </a>
        <PullWorkspaceAction
          root={root}
          pull={pull}
          checkouts={checkouts}
          navigation={navigation}
          disabled={!connected || hidden}
          onCheckouts={setCheckouts}
        />
      </div>
    )
  }
}
