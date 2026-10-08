import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { HostPath, PullDetail, PullSummary, PullsResponse } from '../../../shared'
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
import { preparePullFeedbackPreview } from './pull-feedback-preview'

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
  const [detail, setDetail] = useState<PullDetail>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailPull, setDetailPull] = useState<number>()
  const [selectedThreads, setSelectedThreads] = useState<ReadonlySet<string>>(new Set())
  const [copyStatus, setCopyStatus] = useState<string>()
  const detailSerial = useRef(0)
  const requestSerial = useRef(0)
  const refreshController = useRef<VisibilityRefresh | undefined>(undefined)

  const clearDetail = useCallback((): void => {
    detailSerial.current += 1
    setDetail(undefined)
    setDetailLoading(false)
    setSelectedThreads(new Set())
    setCopyStatus(undefined)
  }, [])

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
      clearDetail()
      setResponse(undefined)
      setCheckouts(undefined)
      setError(undefined)
    }
  }, [clearDetail, refresh])

  useEffect(() => {
    const controller = refreshController.current
    const updateVisibility = (): void => {
      const visible = connected && !hidden && document.visibilityState !== 'hidden'
      if (!visible) clearDetail()
      controller?.setVisible(visible)
    }
    const onFocus = (): void => controller?.focus()
    updateVisibility()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [connected, hidden, refresh, clearDetail])

  useEffect(() => {
    if (detail === undefined) return
    const current =
      response?.available === true
        ? [
            ...response.branchPulls,
            ...response.authored,
            ...response.reviewRequested,
          ].find((pull) => pull.number === detail.number)
        : undefined
    if (
      error === undefined &&
      response?.available === true &&
      response.repo === detail.repo &&
      current?.headOid === detail.headOid
    )
      return
    clearDetail()
    setCopyStatus(
      'Pull request changed or is unavailable; refresh details before copying feedback.',
    )
  }, [detail, response, error, clearDetail])

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
      <div className="pulls-body">
        {renderBody()}
        {detailAnchored() ? null : renderDetail()}
      </div>
    </section>
  )

  function detailAnchored(): boolean {
    return (
      error === undefined &&
      response?.available === true &&
      pullSections(response).some((section) =>
        section.pulls.some((pull) => pull.number === detailPull),
      )
    )
  }

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
              <li key={pull.number}>
                {renderPull(pull, section.key === 'review')}
                {pull.number === detailPull ? renderDetail() : null}
              </li>
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
          repo={response?.available ? response.repo : undefined}
          navigation={navigation}
          disabled={!connected || hidden}
          onCheckouts={setCheckouts}
        />
        <button
          type="button"
          className="pulls-detail-button"
          disabled={!connected || hidden || pull.headOid === undefined || detailLoading}
          onClick={() => void loadDetail(pull)}
        >
          {detailLoading ? 'Loading…' : 'Details'}
        </button>
      </div>
    )
  }

  async function loadDetail(pull: PullSummary): Promise<void> {
    if (
      pull.headOid === undefined ||
      response?.available !== true ||
      hidden ||
      !connected ||
      document.visibilityState === 'hidden'
    )
      return
    const serial = ++detailSerial.current
    setDetailPull(pull.number)
    setDetailLoading(true)
    setDetail(undefined)
    setSelectedThreads(new Set())
    setCopyStatus(undefined)
    try {
      const result = await window.hvir.invoke('github:detail', {
        root,
        repo: response.repo,
        number: pull.number,
        headOid: pull.headOid,
      })
      if (serial !== detailSerial.current || hidden || !connected) return
      if (result.available) setDetail(result)
      else setCopyStatus(result.message)
    } catch (reason) {
      if (serial === detailSerial.current) {
        setCopyStatus(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (serial === detailSerial.current) setDetailLoading(false)
    }
  }

  function renderDetail(): ReactElement | null {
    if (detail === undefined && copyStatus === undefined) return null
    const preview =
      detail === undefined
        ? undefined
        : preparePullFeedbackPreview(detail, selectedThreads)
    return (
      <section
        className="pulls-detail pulls-feedback-detail"
        aria-label="Pull request feedback"
      >
        <div className="pulls-detail-header">
          <span>Selected feedback</span>
          <button type="button" onClick={clearDetail}>
            Close
          </button>
        </div>
        {copyStatus !== undefined ? <p role="alert">{copyStatus}</p> : null}
        {detail !== undefined ? (
          <>
            <p>Current pull request head: {detail.headOid ?? 'unknown'}</p>
            {!detail.threadsPageComplete || detail.payloadTruncated ? (
              <p role="status">Some hosted feedback is incomplete or truncated.</p>
            ) : null}
            <ul>
              {detail.threads.map((thread) => (
                <li key={thread.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedThreads.has(thread.id)}
                      onChange={(event) => {
                        detailSerial.current += 1
                        const next = new Set(selectedThreads)
                        if (event.currentTarget.checked) next.add(thread.id)
                        else next.delete(thread.id)
                        setSelectedThreads(next)
                        setCopyStatus(undefined)
                      }}
                    />
                    <span>
                      {thread.path ?? 'location unknown'}
                      {thread.line === undefined ? '' : `:${thread.line}`}
                    </span>
                  </label>
                  <div className="pulls-detail-thread-state">
                    {thread.isResolved ? 'resolved' : 'open'}
                    {thread.isOutdated ? ' · outdated' : ''}
                    {thread.reviewedCommitOid === undefined
                      ? ' · reviewed commit unknown'
                      : ` · reviewed ${thread.reviewedCommitOid}`}
                  </div>
                  <div className="pulls-detail-comments">
                    {thread.comments.map((comment) => (
                      <p key={comment.id}>
                        <strong>
                          {comment.author === undefined
                            ? 'unknown author'
                            : `@${comment.author}`}
                        </strong>
                        {comment.createdAt === undefined
                          ? null
                          : ` · ${comment.createdAt}`}
                        : {comment.body}
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <pre className="pulls-detail-preview" aria-label="Exact feedback preview">
              {preview?.ok === true ? preview.text : preview?.reason}
            </pre>
            <button
              type="button"
              disabled={preview?.ok !== true}
              onClick={() => {
                if (preview?.ok !== true) return
                const generation = detailSerial.current
                try {
                  const clipboard = navigator.clipboard
                  if (clipboard === undefined) {
                    setCopyStatus('Clipboard copy was refused.')
                    return
                  }
                  void clipboard.writeText(preview.text).then(
                    () => {
                      if (
                        generation === detailSerial.current &&
                        detail !== undefined &&
                        connected &&
                        !hidden
                      ) {
                        setCopyStatus('Exact preview copied.')
                      }
                    },
                    () => {
                      if (
                        generation === detailSerial.current &&
                        detail !== undefined &&
                        connected &&
                        !hidden
                      ) {
                        setCopyStatus('Clipboard copy was refused.')
                      }
                    },
                  )
                } catch {
                  if (
                    generation === detailSerial.current &&
                    detail !== undefined &&
                    connected &&
                    !hidden
                  ) {
                    setCopyStatus('Clipboard copy was refused.')
                  }
                }
              }}
            >
              Copy preview
            </button>
          </>
        ) : null}
      </section>
    )
  }
}
