import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'

import {
  PULLS_MAX_LIMIT,
  PULLS_PAGE_SIZE,
  type HostPath,
  type PullDetail,
  type PullSummary,
  type PullsResponse,
  type PullsSnapshot,
} from '../../../shared'
import { createVisibilityRefresh, type VisibilityRefresh } from '../beads/beads-refresh'
import {
  pullSections,
  unavailableHint,
  type PullSection,
  type PullSectionKey,
} from './pulls-model'

import type { PullCheckoutsResponse } from '../../../shared/github'
import { PullRow } from './PullRow'
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
  const [limit, setLimit] = useState(PULLS_PAGE_SIZE)
  const limitRef = useRef(PULLS_PAGE_SIZE)
  const detailSerial = useRef(0)
  const requestSerial = useRef(0)
  const refreshController = useRef<VisibilityRefresh | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<ReadonlySet<PullSectionKey>>(new Set())
  const toggleSection = useCallback((key: PullSectionKey): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  const { now, sections } = useMemo(() => {
    const at = Date.now()
    return {
      now: at,
      sections: response?.available === true ? pullSections(response, at) : [],
    }
  }, [response])

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
        window.hvir.invoke('github:pulls', { root, limit: limitRef.current }),
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
      limitRef.current = PULLS_PAGE_SIZE
      setLimit(PULLS_PAGE_SIZE)
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
      sections.some((section) =>
        section.rows.some((row) => row.pull.number === detailPull),
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
    const branchNote =
      response.branch === undefined
        ? 'Detached HEAD, so no branch pull request.'
        : `No pull request for ${response.branch}.`
    return (
      <>
        {sections.map((section) =>
          section.key === 'branch' || section.rows.length > 0
            ? renderSection(
                section,
                response,
                section.key === 'branch' ? branchNote : undefined,
              )
            : null,
        )}
        {sections.every((section) => section.rows.length === 0) ? (
          <p className="pulls-empty">Nothing open that is yours or waiting on you.</p>
        ) : null}
        {response.hasMore ? renderShowMore() : null}
      </>
    )
  }

  function renderShowMore(): ReactElement {
    if (limit >= PULLS_MAX_LIMIT) {
      return (
        <p className="pulls-section-note">
          Showing the first {PULLS_MAX_LIMIT} of each list. Open GitHub for the rest.
        </p>
      )
    }
    return (
      <button
        type="button"
        className="pulls-more"
        disabled={loading || !connected}
        onClick={() => {
          const next = Math.min(limit + PULLS_PAGE_SIZE, PULLS_MAX_LIMIT)
          limitRef.current = next
          setLimit(next)
          refreshController.current?.request()
        }}
      >
        Show more pull requests
      </button>
    )
  }

  function renderSection(
    section: PullSection,
    snapshot: PullsSnapshot,
    emptyNote: string | undefined,
  ): ReactElement {
    const open = !collapsed.has(section.key)
    return (
      <div className="pulls-section" key={section.key}>
        <button
          type="button"
          className="pulls-section-header"
          aria-expanded={open}
          onClick={() => toggleSection(section.key)}
        >
          <span className="pulls-section-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="pulls-section-label">{section.label}</span>
          <span className="pulls-section-count">{section.rows.length}</span>
        </button>
        {!open ? null : section.rows.length === 0 && emptyNote !== undefined ? (
          <p className="pulls-section-note">{emptyNote}</p>
        ) : (
          <ul className="pulls-list">
            {section.rows.map((row) => (
              <li key={row.pull.number}>
                <PullRow
                  row={row}
                  now={now}
                  showAuthor={row.pull.author !== snapshot.viewer}
                  root={root}
                  repo={snapshot.repo}
                  checkouts={checkouts}
                  navigation={navigation}
                  disabled={!connected || hidden}
                  detailLoading={detailLoading}
                  onCheckouts={setCheckouts}
                  onDetail={(pull) => void loadDetail(pull)}
                />
                {row.pull.number === detailPull ? renderDetail() : null}
              </li>
            ))}
          </ul>
        )}
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
