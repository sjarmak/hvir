import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'

import type {
  ProjectState,
  SessionsAttachExternalTarget,
  SessionsAttachExternalUnavailableReason,
  SessionsLivePtyQualifier,
  SessionsOpenUnavailableReason,
  SessionsProjectionRow,
  SessionsTerminalHandle,
  SessionsWorkspaceQualifier,
} from '../../../shared'
import { SessionsOverviewCard } from './SessionsOverviewCard'
import { SessionsOverviewNotice } from './SessionsOverviewNotice'
import { SessionsCollectionToolbar } from './SessionsCollectionToolbar'
import { SessionsTerminalDetail } from './SessionsTerminalDetail'
import { SessionsTranscriptDetail } from './SessionsTranscriptDetail'
import {
  SessionsProjectionCoordinator,
  createSessionsMainObservationPort,
} from './sessions-projection-coordinator'
import type { SessionsRendererObservationPort } from './sessions-renderer-observation'
import {
  sessionsDetailContext,
  type SessionsTerminalDetailContext,
} from './sessions-terminal-detail-controller'
import { sessionsTerminalOverlayOrigin } from './sessions-terminal-overlay'
import {
  sessionsTerminalSurfaceEligible,
  type SessionsTerminalSurfacePort,
} from './sessions-terminal-surface'
import { useSessionsForeground } from './use-sessions-foreground'
import { useSessionsTerminalDetail } from './use-sessions-terminal-detail'
import { useSessionsTranscript } from './use-sessions-transcript'
import {
  DEFAULT_SESSIONS_OVERVIEW_POLICY,
  SESSIONS_OVERVIEW_PAGE_SIZE,
  sessionsOverviewFocusFallback,
  sessionsOverviewCardIdentity,
  sessionsOverviewGroups,
  sessionsOverviewPage,
  sessionsOverviewPolicyLabel,
  sessionsOverviewRows,
  sessionsOverviewWorkspaces,
  type SessionsOverviewPolicy,
} from './sessions-overview-model'

interface SessionsOverviewProps {
  readonly observation: SessionsRendererObservationPort
  readonly surface: SessionsTerminalSurfacePort
  readonly onOpened: (state: ProjectState) => void
  readonly onFocusOpened: (
    handle: SessionsTerminalHandle,
    workspaceQualifier: SessionsWorkspaceQualifier,
    livePty: SessionsLivePtyQualifier,
  ) => Promise<boolean>
  readonly onOpenFailed: (message: string) => void
  /**
   * Runs the attach command main composed for a projected row, in the workspace
   * the attach switched to. The renderer never learns which foreign session the
   * command names: it carries main's ticket and nothing else (ADR-046).
   */
  readonly onAttachExternal: (
    workspaceId: string,
    target: SessionsAttachExternalTarget,
  ) => Promise<boolean>
}

export function SessionsOverview({
  observation,
  surface,
  onOpened,
  onFocusOpened,
  onOpenFailed,
  onAttachExternal,
}: SessionsOverviewProps): ReactElement {
  const coordinator = useRef<SessionsProjectionCoordinator | undefined>(undefined)
  coordinator.current ??= new SessionsProjectionCoordinator(
    createSessionsMainObservationPort(window.hvir),
    observation,
  )
  const source = coordinator.current
  const foreground = useSessionsForeground()
  const snapshot = useSyncExternalStore(
    source.subscribe,
    source.snapshot,
    source.snapshot,
  )
  const { controller: detail, state: detailState } = useSessionsTerminalDetail({
    surface,
    snapshot,
    foreground,
  })
  const { coordinator: transcripts, state: transcriptState } = useSessionsTranscript({
    snapshot,
    foreground,
  })
  const [policy, setPolicy] = useState<SessionsOverviewPolicy>(
    DEFAULT_SESSIONS_OVERVIEW_POLICY,
  )
  const [selected, setSelected] = useState<SessionsTerminalHandle>()
  const [feedback, setFeedback] = useState<string>()
  const [opening, setOpening] = useState<SessionsTerminalHandle>()
  const [transcript, setTranscript] = useState<SessionsTranscriptTarget>()
  const [attaching, setAttaching] = useState<SessionsTerminalHandle>()
  const detailOrigin = useRef<ReturnType<typeof sessionsTerminalOverlayOrigin>>(undefined)
  const [pageIndex, setPageIndex] = useState(0)
  const previousOrder = useRef<readonly SessionsTerminalHandle[]>([])
  const pendingFocus = useRef<SessionsTerminalHandle | undefined>(undefined)
  const rowElements = useRef(new Map<SessionsTerminalHandle, HTMLElement>())
  const collectionControl = useRef<HTMLButtonElement>(null)
  const openGeneration = useRef(0)
  // Either pane is a modal over the list, so the list is inert behind both.
  const detailActive = detailState.status !== 'inactive' || transcript !== undefined

  useEffect(() => {
    if (!foreground) return
    const release = source.acquire()
    return release
  }, [foreground, source])
  useEffect(() => {
    if (foreground) return
    openGeneration.current += 1
    rowElements.current.clear()
    setOpening(undefined)
    setAttaching(undefined)
    setTranscript(undefined)
    detailOrigin.current = undefined
    setFeedback(undefined)
    pendingFocus.current = undefined
  }, [foreground])
  useEffect(
    () => () => {
      openGeneration.current += 1
    },
    [],
  )

  const allGroups = useMemo(
    () => sessionsOverviewGroups(snapshot.rows, policy),
    [policy, snapshot.rows],
  )
  const rows = useMemo(() => sessionsOverviewRows(allGroups), [allGroups])
  const handles = useMemo(() => rows.map((row) => row.handle), [rows])
  const page = useMemo(
    () => sessionsOverviewPage(allGroups, pageIndex),
    [allGroups, pageIndex],
  )
  useEffect(() => {
    if (!foreground || snapshot.status !== 'available') return
    if (page.pageIndex !== pageIndex) setPageIndex(page.pageIndex)
  }, [foreground, page.pageIndex, pageIndex, snapshot.status])
  useEffect(() => {
    if (!foreground || snapshot.status !== 'available') return
    const selectedDisappeared = selected !== undefined && !handles.includes(selected)
    const next = sessionsOverviewFocusFallback(previousOrder.current, handles, selected)
    previousOrder.current = handles
    const nextIndex = next ? handles.indexOf(next) : -1
    if (nextIndex >= 0) {
      const nextPage = Math.floor(nextIndex / SESSIONS_OVERVIEW_PAGE_SIZE)
      if (nextPage !== pageIndex) setPageIndex(nextPage)
    }
    if (next !== selected) {
      setSelected(next)
    }
    if (selectedDisappeared && document.activeElement === document.body) {
      if (next) pendingFocus.current = next
      else collectionControl.current?.focus()
    }
  }, [foreground, handles, pageIndex, selected, snapshot.status])
  useEffect(() => {
    const handle = pendingFocus.current
    if (!handle || !page.rows.some((row) => row.handle === handle)) return
    pendingFocus.current = undefined
    rowElements.current.get(handle)?.focus()
  }, [page.rows])
  useLayoutEffect(() => {
    if (detailActive) return
    const handle = pendingFocus.current
    if (!handle) return
    pendingFocus.current = undefined
    const row = rowElements.current.get(handle)
    if (row) row.focus()
    else collectionControl.current?.focus()
  }, [detailActive])
  useEffect(() => {
    // The header is the row's, and the row keeps changing while the pane reads
    // it. A row that leaves the projection keeps the header it had: what the
    // pane reports then is main's own unavailable reason, not a blank dialog.
    if (!transcript) return
    const row = snapshot.rows.find((candidate) => candidate.handle === transcript.handle)
    const next = row ? transcriptTarget(row) : undefined
    if (next && !sameTranscriptTarget(next, transcript)) setTranscript(next)
  }, [snapshot.rows, transcript])

  const updatePolicy = <K extends keyof SessionsOverviewPolicy>(
    key: K,
    value: SessionsOverviewPolicy[K],
  ): void => {
    setPolicy((current) => ({ ...current, [key]: value }))
    setSelected(undefined)
    setPageIndex(0)
    setFeedback(undefined)
  }

  const open = useCallback(
    async (row: SessionsProjectionRow): Promise<void> => {
      if (opening) return
      const captured = source.snapshot()
      const generation = (openGeneration.current += 1)
      setOpening(row.handle)
      setFeedback('Opening exact terminal…')
      try {
        const result = await window.hvir.invoke('sessions:open', {
          demandGeneration: captured.demandGeneration,
          sourceRevision: captured.sourceRevision,
          handle: row.handle,
          projectId: row.project.id,
          workspaceId: row.workspace.id,
          workspaceQualifier: row.workspace.qualifier,
          livePty: row.livePty,
        })
        if (generation !== openGeneration.current) return
        if (result.outcome === 'unavailable') {
          setFeedback(
            openUnavailableMessage(
              source.snapshot().revision !== captured.revision
                ? 'stale-projection'
                : result.reason,
            ),
          )
          return
        }
        onOpened(result.state)
        const focused = await onFocusOpened(
          result.handle,
          result.workspaceQualifier,
          result.livePty,
        )
        if (!focused)
          onOpenFailed('The exact terminal changed before it could receive focus')
      } catch {
        if (generation === openGeneration.current) {
          setFeedback('The exact terminal could not be opened')
        }
      } finally {
        if (generation === openGeneration.current) setOpening(undefined)
      }
    },
    [onFocusOpened, onOpenFailed, onOpened, opening, source],
  )

  const openDetailWorkspace = useCallback((): void => {
    const handle = detail.selectedHandle()
    if (handle) pendingFocus.current = handle
    detail.close()
    detailOrigin.current = undefined
    if (!handle) {
      setFeedback(openUnavailableMessage('session-unavailable'))
      return
    }
    const row = source.snapshot().rows.find((candidate) => candidate.handle === handle)
    if (!row) {
      setFeedback(openUnavailableMessage('session-unavailable'))
      return
    }
    void open(row)
  }, [detail, open, source])

  const openTranscript = useCallback(
    (row: SessionsProjectionRow): void => {
      const target = transcriptTarget(row)
      if (!target) return
      detailOrigin.current = sessionsTerminalOverlayOrigin(
        rowElements.current.get(row.handle),
      )
      setFeedback(undefined)
      setTranscript(target)
      transcripts.open(row.handle, source.snapshot())
    },
    [source, transcripts],
  )

  const closeTranscript = useCallback((): void => {
    pendingFocus.current = transcripts.selectedHandle()
    transcripts.close()
    setTranscript(undefined)
    detailOrigin.current = undefined
  }, [transcripts])

  /** The row the terminal detail is showing, as a transcript. */
  const showTranscript = useCallback((): void => {
    const handle = detail.selectedHandle()
    const row = handle
      ? source.snapshot().rows.find((candidate) => candidate.handle === handle)
      : undefined
    const target = row ? transcriptTarget(row) : undefined
    if (!target) {
      pendingFocus.current = handle
      detail.close()
      setFeedback(openUnavailableMessage('session-unavailable'))
      return
    }
    detail.close()
    setTranscript(target)
    transcripts.open(target.handle, source.snapshot())
  }, [detail, source, transcripts])

  /** The borrowed terminal for a row hvir already owns a live PTY for. */
  const showTerminal = useCallback((): void => {
    const handle = transcripts.selectedHandle()
    const captured = source.snapshot()
    const row = handle
      ? captured.rows.find((candidate) => candidate.handle === handle)
      : undefined
    if (!row || !sessionsTerminalSurfaceEligible(row)) {
      closeTranscript()
      setFeedback(openUnavailableMessage('terminal-unavailable'))
      return
    }
    transcripts.close()
    setTranscript(undefined)
    detail.open(row, captured, foreground)
  }, [closeTranscript, detail, foreground, source, transcripts])

  /**
   * Hands the row to hvir's own terminal: main switches to the owning
   * workspace, mints a ticket for the session, and the workspace runs the
   * command that ticket stands for.
   */
  const attach = useCallback(async (): Promise<void> => {
    const handle = transcripts.selectedHandle()
    if (attaching !== undefined || handle === undefined) return
    const captured = source.snapshot()
    const row = captured.rows.find((candidate) => candidate.handle === handle)
    if (!row) {
      setFeedback(openUnavailableMessage('session-unavailable'))
      return
    }
    const generation = (openGeneration.current += 1)
    setAttaching(handle)
    try {
      const result = await window.hvir.invoke('sessions:attach-external', {
        demandGeneration: captured.demandGeneration,
        sourceRevision: captured.sourceRevision,
        handle,
        projectId: row.project.id,
        workspaceId: row.workspace.id,
        workspaceQualifier: row.workspace.qualifier,
      })
      if (generation !== openGeneration.current) return
      if (result.outcome === 'unavailable') {
        setFeedback(
          attachUnavailableMessage(
            source.snapshot().revision !== captured.revision
              ? 'stale-projection'
              : result.reason,
          ),
        )
        return
      }
      closeTranscript()
      onOpened(result.state)
      const launched = await onAttachExternal(
        result.state.activeWorkspaceId,
        result.target,
      )
      if (!launched)
        onOpenFailed('The attach command could not be started in that workspace')
    } catch {
      if (generation === openGeneration.current) {
        setFeedback('This session could not be attached')
      }
    } finally {
      if (generation === openGeneration.current) setAttaching(undefined)
    }
  }, [
    attaching,
    closeTranscript,
    onAttachExternal,
    onOpenFailed,
    onOpened,
    source,
    transcripts,
  ])
  const forget = useCallback(
    async (row: SessionsProjectionRow): Promise<void> => {
      const captured = source.snapshot()
      try {
        const result = await window.hvir.invoke('sessions:forget', {
          demandGeneration: captured.demandGeneration,
          sourceRevision: captured.sourceRevision,
          handle: row.handle,
          projectId: row.project.id,
          workspaceId: row.workspace.id,
          workspaceQualifier: row.workspace.qualifier,
        })
        if (result.outcome === 'unavailable') {
          setFeedback(openUnavailableMessage(result.reason))
        }
      } catch {
        setFeedback('The session record could not be forgotten')
      }
    },
    [source],
  )

  const rename = useCallback(
    async (row: SessionsProjectionRow, title: string): Promise<void> => {
      const cleaned = title.trim()
      if (!cleaned) return
      const captured = source.snapshot()
      try {
        const result = await window.hvir.invoke('sessions:rename', {
          demandGeneration: captured.demandGeneration,
          sourceRevision: captured.sourceRevision,
          handle: row.handle,
          projectId: row.project.id,
          workspaceId: row.workspace.id,
          workspaceQualifier: row.workspace.qualifier,
          title: cleaned,
        })
        if (result.outcome === 'unavailable') {
          setFeedback(openUnavailableMessage(result.reason))
        }
      } catch {
        setFeedback('The session could not be renamed')
      }
    },
    [source],
  )

  const moveFocus = (
    event: ReactKeyboardEvent<HTMLElement>,
    row: SessionsProjectionRow,
  ): void => {
    if (event.target !== event.currentTarget) return
    const index = handles.indexOf(row.handle)
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, handles.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? handles.length - 1
              : undefined
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = handles[nextIndex]
    if (!next) return
    setSelected(next)
    const nextPage = Math.floor(nextIndex / SESSIONS_OVERVIEW_PAGE_SIZE)
    if (nextPage === page.pageIndex) rowElements.current.get(next)?.focus()
    else {
      pendingFocus.current = next
      setPageIndex(nextPage)
    }
  }

  const showPage = (nextPage: number): void => {
    const next = sessionsOverviewPage(allGroups, nextPage)
    const target = next.rows[0]
    setPageIndex(next.pageIndex)
    if (!target) return
    setSelected(target.handle)
    pendingFocus.current = target.handle
  }

  const policyLabel = sessionsOverviewPolicyLabel(policy)
  const detailTranscriptOffered = useMemo(() => {
    if (detailState.status === 'inactive') return false
    const handle = detail.selectedHandle()
    const row = handle
      ? snapshot.rows.find((candidate) => candidate.handle === handle)
      : undefined
    return row?.origin.kind === 'external-agent'
  }, [detail, detailState, snapshot.rows])
  return (
    <>
      <main
        className={`sessions-overview${detailActive ? ' detail-active' : ''}`}
        aria-label={detailActive ? undefined : 'Sessions'}
        aria-hidden={detailActive || undefined}
        inert={detailActive || undefined}
      >
        <SessionsCollectionToolbar
          policy={policy}
          collectionControl={collectionControl}
          onFilter={(value) => updatePolicy('filter', value)}
          onGroup={(value) => updatePolicy('group', value)}
          onSort={(value) => updatePolicy('sort', value)}
        />
        {feedback ? (
          <p className="sessions-feedback" role="status">
            {feedback}
          </p>
        ) : null}
        {!foreground ? (
          <SessionsOverviewNotice
            title="Updates paused"
            detail="Focus hvir to refresh Sessions."
          />
        ) : snapshot.status === 'pending' ? (
          <SessionsOverviewNotice
            title="Loading sessions"
            detail="Reading the current hvir-owned session projection."
          />
        ) : snapshot.status === 'unavailable' ? (
          <SessionsOverviewNotice
            title="Sessions unavailable"
            detail="The current projection could not be read."
            action={
              <button type="button" onClick={() => source.retry()}>
                Retry
              </button>
            }
          />
        ) : snapshot.status === 'available' && snapshot.rows.length === 0 ? (
          <SessionsOverviewNotice
            title="No hvir sessions"
            detail="Start a terminal from a workspace to see it here."
          />
        ) : snapshot.status === 'available' && rows.length === 0 ? (
          <SessionsOverviewNotice
            title="No sessions match"
            detail={policyLabel}
            action={
              <button
                type="button"
                onClick={() => {
                  setPolicy(DEFAULT_SESSIONS_OVERVIEW_POLICY)
                  setSelected(undefined)
                  setPageIndex(0)
                  setFeedback(undefined)
                }}
              >
                Reset filters
              </button>
            }
          />
        ) : (
          <>
            <nav className="sessions-pagination" aria-label="Sessions pages">
              <p aria-live="polite">
                Showing {page.start + 1}–{page.end} of {page.totalRows} sessions
              </p>
              {page.pageCount > 1 ? (
                <div>
                  <button
                    type="button"
                    disabled={page.pageIndex === 0}
                    onClick={() => showPage(page.pageIndex - 1)}
                  >
                    Previous page
                  </button>
                  <span>
                    Page {page.pageIndex + 1} of {page.pageCount}
                  </span>
                  <button
                    type="button"
                    disabled={page.pageIndex + 1 >= page.pageCount}
                    onClick={() => showPage(page.pageIndex + 1)}
                  >
                    Next page
                  </button>
                </div>
              ) : null}
            </nav>
            <div className="sessions-groups" role="list" aria-label="hvir sessions">
              {page.groups.map((group, groupIndex) => {
                const headingId = group.label ? `sessions-group-${groupIndex}` : undefined
                const sections =
                  policy.group === 'workspace'
                    ? sessionsOverviewWorkspaces(group.rows)
                    : [{ key: group.key, rows: group.rows }]
                return (
                  <section
                    className={`sessions-group${group.label ? '' : ' ungrouped'}`}
                    key={group.key}
                    aria-labelledby={headingId}
                  >
                    {group.label ? (
                      <header className="sessions-project-header">
                        <h2 id={headingId}>{group.label}</h2>
                        <span>
                          {group.rows.length}{' '}
                          {group.rows.length === 1 ? 'session' : 'sessions'}
                        </span>
                        {group.rows[0]?.host.kind === 'ssh' ? (
                          <span
                            className="sessions-project-host"
                            title={group.rows[0].host.label}
                          >
                            SSH
                          </span>
                        ) : null}
                      </header>
                    ) : null}
                    {sections.map((section) => (
                      <div className="sessions-workspace" key={section.key}>
                        {'label' in section ? (
                          <h3 className="sessions-worktree-heading">
                            <svg
                              className="sessions-branch-icon"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <circle cx="6" cy="4" r="2" />
                              <circle cx="6" cy="20" r="2" />
                              <circle cx="18" cy="6" r="2" />
                              <path d="M6 6v12M18 8v2a6 6 0 0 1-6 6H6" />
                            </svg>
                            {section.label}
                          </h3>
                        ) : null}
                        <div className="sessions-grid">
                          {section.rows.map((row) => {
                            const isSelected = selected === row.handle
                            const liveTerminal = sessionsTerminalSurfaceEligible(row)
                            // A row someone else's agent owns has a transcript
                            // whether or not hvir holds a terminal for it.
                            const external = row.origin.kind === 'external-agent'
                            const cardIdentity = sessionsOverviewCardIdentity(
                              row,
                              policy.group,
                            )
                            return (
                              <article
                                key={row.handle}
                                className={`session-card${isSelected ? ' selected' : ''}`}
                                role="listitem"
                                aria-current={isSelected ? 'true' : undefined}
                                aria-label={cardIdentity.accessibleName}
                                tabIndex={isSelected ? 0 : -1}
                                ref={(element) => {
                                  if (element)
                                    rowElements.current.set(row.handle, element)
                                  else rowElements.current.delete(row.handle)
                                }}
                                onFocus={() => setSelected(row.handle)}
                                onClick={() => setSelected(row.handle)}
                                onKeyDown={(event) => {
                                  if (
                                    event.key === 'Enter' &&
                                    event.target === event.currentTarget
                                  ) {
                                    event.preventDefault()
                                    if (liveTerminal) void open(row)
                                    else if (external) openTranscript(row)
                                    return
                                  }
                                  moveFocus(event, row)
                                }}
                              >
                                <SessionsOverviewCard
                                  row={row}
                                  group={policy.group}
                                  opening={opening === row.handle}
                                  onOpen={liveTerminal ? () => void open(row) : undefined}
                                  onInteract={
                                    liveTerminal
                                      ? () => {
                                          detailOrigin.current =
                                            sessionsTerminalOverlayOrigin(
                                              rowElements.current.get(row.handle),
                                            )
                                          detail.open(row, source.snapshot(), foreground)
                                        }
                                      : external
                                        ? () => openTranscript(row)
                                        : undefined
                                  }
                                  onForget={
                                    row.lifecycle === 'retained'
                                      ? () => void forget(row)
                                      : undefined
                                  }
                                  onRename={
                                    row.lifecycle === 'retained'
                                      ? (title: string) => void rename(row, title)
                                      : undefined
                                  }
                                />
                              </article>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </section>
                )
              })}
            </div>
          </>
        )}
      </main>
      {detailState.status !== 'inactive' ? (
        <SessionsTerminalDetail
          controller={detail}
          state={detailState}
          origin={detailOrigin.current}
          onBack={() => {
            pendingFocus.current = detail.selectedHandle()
            detail.close()
            detailOrigin.current = undefined
          }}
          onOpenWorkspace={openDetailWorkspace}
          onShowTranscript={detailTranscriptOffered ? showTranscript : undefined}
        />
      ) : null}
      {transcript ? (
        <SessionsTranscriptDetail
          context={transcript.context}
          sourceName={transcript.sourceName}
          state={transcriptState}
          origin={detailOrigin.current}
          attaching={attaching === transcript.handle}
          onBack={closeTranscript}
          onResume={() => transcripts.resume()}
          onAttach={() => void attach()}
          onShowTerminal={transcript.live ? showTerminal : undefined}
          onRespond={(optionOrdinal) => transcripts.respond(optionOrdinal)}
          onSubmit={(message) => transcripts.submit(message)}
        />
      ) : null}
    </>
  )
}

/** What a transcript pane shows in its header, and what it may offer. */
interface SessionsTranscriptTarget {
  readonly handle: SessionsTerminalHandle
  /** The owning authority's own name, so the pane says whose session it is. */
  readonly sourceName: string
  readonly context: SessionsTerminalDetailContext
  /** hvir owns a live terminal for the row, so the terminal is offered too. */
  readonly live: boolean
}

/** Only a row another authority owns has a transcript hvir can read. */
function transcriptTarget(
  row: SessionsProjectionRow,
): SessionsTranscriptTarget | undefined {
  if (row.origin.kind !== 'external-agent') return undefined
  return {
    handle: row.handle,
    sourceName: row.origin.sourceName,
    context: sessionsDetailContext(row),
    live: sessionsTerminalSurfaceEligible(row),
  }
}

function sameTranscriptTarget(
  left: SessionsTranscriptTarget,
  right: SessionsTranscriptTarget,
): boolean {
  return (
    left.handle === right.handle &&
    left.sourceName === right.sourceName &&
    left.live === right.live &&
    left.context.title === right.context.title &&
    left.context.projectName === right.context.projectName &&
    left.context.workspaceName === right.context.workspaceName &&
    left.context.hostLabel === right.context.hostLabel &&
    left.context.providerName === right.context.providerName
  )
}

function attachUnavailableMessage(
  reason: SessionsAttachExternalUnavailableReason,
): string {
  switch (reason) {
    case 'stale-projection':
      return 'Sessions changed. Review the refreshed row before attaching it.'
    case 'not-projected':
      return 'This session is no longer listed here.'
    case 'workspace-unavailable':
      return 'The owning workspace is not available.'
    case 'connection-unavailable':
      return 'The host is disconnected. Reconnect from the workspace before attaching.'
  }
}

function openUnavailableMessage(reason: SessionsOpenUnavailableReason): string {
  switch (reason) {
    case 'stale-projection':
      return 'Sessions changed. Review the refreshed row before opening it.'
    case 'session-unavailable':
      return 'This session is no longer available.'
    case 'workspace-unavailable':
      return 'The owning workspace is not available.'
    case 'connection-unavailable':
      return 'The host is disconnected. Reconnect from the workspace before opening it.'
    case 'terminal-unavailable':
      return 'This session does not have the same live terminal anymore.'
  }
}
