import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import type { SessionsProjectionRow } from '../../../shared'
import type { SessionsProjectionCoordinator } from '../sessions/sessions-projection-coordinator'
import { useSessionsForeground } from '../sessions/use-sessions-foreground'
import { NeedsYouCoordinator } from './needs-you-coordinator'
import { needsYouProblems } from './needs-you-problems'
import { needsYouRows, type NeedsYouBeadTarget, type NeedsYouRow } from './needs-you-rows'
import './needs-you.css'

export type { NeedsYouBeadTarget } from './needs-you-rows'

const PAGE_SIZE = 50

export function NeedsYouView({
  projection,
  onSession,
  onBead,
  onError,
}: {
  readonly projection: SessionsProjectionCoordinator
  readonly onSession: (row: SessionsProjectionRow) => void
  readonly onBead: (target: NeedsYouBeadTarget) => Promise<boolean | void>
  readonly onError: (message: string) => void
}): ReactElement {
  const foreground = useSessionsForeground()
  const errorReporter = useRef(onError)
  errorReporter.current = onError
  const [source] = useState(
    () =>
      new NeedsYouCoordinator(
        {
          observe: (demandGeneration) =>
            window.hvir.invoke('needs-you:observe', { demandGeneration }),
          refresh: (demandGeneration) =>
            window.hvir.invoke('needs-you:snapshot', { demandGeneration }),
          release: (demandGeneration) =>
            window.hvir.invoke('needs-you:release', { demandGeneration }),
          subscribe: (listener) => window.hvir.on('needs-you:changed', listener),
        },
        (message) => errorReporter.current(message),
      ),
  )
  const reads = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  const sessions = useSyncExternalStore(
    projection.subscribe,
    projection.snapshot,
    projection.snapshot,
  )
  const [pageIndex, setPageIndex] = useState(0)
  const [opening, setOpening] = useState<string>()
  const [feedback, setFeedback] = useState<string>()
  const actionGeneration = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  useEffect(() => {
    if (!foreground) return
    setOpening(undefined)
    setFeedback(undefined)
    const releaseSources = source.acquire()
    const releaseSessions = projection.acquire()
    return () => {
      actionGeneration.current += 1
      releaseSources()
      releaseSessions()
    }
  }, [foreground, projection, source])
  const rows = useMemo(
    () =>
      foreground
        ? needsYouRows(
            sessions.status === 'available' ? sessions.rows : [],
            reads.status === 'available' ? reads.snapshot.sources : [],
            reads.status === 'available' ? reads.snapshot.askStores : [],
          )
        : [],
    [foreground, reads, sessions],
  )
  const problems = useMemo(
    () => (reads.status === 'available' ? needsYouProblems(reads.snapshot) : []),
    [reads],
  )
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const page = Math.min(pageIndex, pageCount - 1)
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const activate = async (row: NeedsYouRow): Promise<void> => {
    if (opening || row.target.kind === 'pull' || row.target.kind === 'ask') return
    if (row.target.kind === 'session') {
      onSession(row.target.row)
      return
    }
    const generation = ++actionGeneration.current
    setOpening(row.key)
    setFeedback(undefined)
    try {
      await onBead(row.target.bead)
    } catch (error) {
      if (generation !== actionGeneration.current) return
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === actionGeneration.current) setOpening(undefined)
    }
  }

  return (
    <section className="needs-you-view" aria-labelledby="needs-you-heading">
      <header className="needs-you-header">
        <div>
          <h1 id="needs-you-heading" ref={heading} tabIndex={-1}>
            Needs you
          </h1>
          <p>Source-reported attention. Opening an item does not resolve it.</p>
        </div>
        <button
          type="button"
          disabled={!foreground || reads.status === 'pending'}
          onClick={() => {
            source.refresh()
            if (sessions.status === 'unavailable') projection.retry()
          }}
        >
          Refresh
        </button>
      </header>
      <p className="needs-you-scope">
        Beads and PRs: open, present workspaces on connected hosts, plus the Gas City
        decisions store. PR searches include up to 30 authored and 30 review-requested
        items per repository.
      </p>
      <div role="status">
        {!foreground ? (
          <p>Observation paused while this window is inactive.</p>
        ) : (
          <>
            {reads.status === 'pending' && <p>Reading Beads and pull requests…</p>}
            {reads.status === 'unavailable' && (
              <p className="needs-you-error">{reads.message}</p>
            )}
            {sessions.status === 'pending' && <p>Reading session attention…</p>}
            {sessions.status === 'unavailable' && (
              <p className="needs-you-error">Session attention is unavailable.</p>
            )}
          </>
        )}
        {feedback && <p className="needs-you-error">{feedback}</p>}
      </div>
      <ul className="needs-you-list" aria-label="Items needing attention">
        {visible.map((row) => (
          <li key={row.key}>
            <span className="needs-you-source">{row.source}</span>
            {row.target.kind === 'pull' ? (
              <a href={row.target.url} target="_blank" rel="noopener noreferrer">
                {row.title}
                <span className="needs-you-action">Open on GitHub</span>
              </a>
            ) : row.target.kind === 'ask' ? (
              <span className="needs-you-title">{row.title}</span>
            ) : (
              <button
                type="button"
                disabled={opening !== undefined}
                onClick={() => void activate(row)}
              >
                {row.title}
                <span className="needs-you-action">
                  {opening === row.key
                    ? 'Opening…'
                    : row.target.kind === 'bead'
                      ? 'Open Bead'
                      : 'View session'}
                </span>
              </button>
            )}
            <span className="needs-you-reason">{row.reason}</span>
            <span className="needs-you-context">{row.context}</span>
          </li>
        ))}
      </ul>
      {foreground &&
        !rows.length &&
        reads.status === 'available' &&
        sessions.status === 'available' && (
          <p>
            No actionable items in the available reads. Sources with problems below may
            still need attention.
          </p>
        )}
      {pageCount > 1 && (
        <nav className="needs-you-pagination" aria-label="Attention pages">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPageIndex(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {pageCount} · {rows.length} items
          </span>
          <button
            type="button"
            disabled={page + 1 === pageCount}
            onClick={() => setPageIndex(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
      {foreground && reads.status === 'available' && (
        <details className="needs-you-reads" open>
          <summary>
            {problems.length} of{' '}
            {reads.snapshot.sources.length + (reads.snapshot.askStores?.length ?? 0)}{' '}
            sources reported problems · Read at{' '}
            {new Date(reads.snapshot.observedAt).toLocaleTimeString()}
          </summary>
          {(reads.snapshot.omittedSourceCount ?? 0) > 0 && (
            <p className="needs-you-error">
              {reads.snapshot.omittedSourceCount} workspaces omitted by the{' '}
              {reads.snapshot.candidateLimit}-workspace read limit. Open their project
              rails for full coverage.
            </p>
          )}
          {reads.snapshot.sources.length === 0 && <p>No eligible workspaces.</p>}
          {problems.map((problem) => (
            <div key={problem.key}>
              <strong>
                {problem.name} · {problem.root.hostId}:{problem.root.path}
              </strong>
              {problem.details.map((detail) => (
                <p key={detail}>{detail}</p>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
