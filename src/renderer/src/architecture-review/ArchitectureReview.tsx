import { useEffect, useRef, useState } from 'react'
import { joinHostPath, type HostPath } from '../../../shared'
import type {
  ArchitectureComparisonMode,
  ArchitectureEvidence,
  ArchitectureReviewSnapshot,
} from '../../../shared/architecture-review'
import { ArchitectureMap } from './ArchitectureMap'
import { ArchitectureEvidencePanel } from './ArchitectureEvidencePanel'
import type { ArchitectureMapMode } from './architecture-review-model'

const MODES: readonly ArchitectureComparisonMode[] = [
  'working-tree',
  'head',
  'branch-point',
  'commit',
]

export function ArchitectureReview({
  root,
  active,
}: {
  readonly root: HostPath
  readonly active: boolean
}) {
  const requestEpoch = useRef(0)
  const [reviewId] = useState(() => crypto.randomUUID())
  const [mode, setMode] = useState<ArchitectureComparisonMode>('working-tree')
  const [revision, setRevision] = useState('')
  const [snapshot, setSnapshot] = useState<ArchitectureReviewSnapshot>()
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string>()
  const [mapMode, setMapMode] = useState<ArchitectureMapMode>('overlay')
  const [evidence, setEvidence] = useState<ArchitectureEvidence>()
  const [selection, setSelection] = useState<{
    path: string
    line: number
    side: 'before' | 'after'
  }>()
  useEffect(
    () => () => {
      requestEpoch.current += 1
      void window.hvir
        .invoke('architecture-review:close', { root, reviewId })
        .catch((cause: unknown) =>
          console.error('Architecture review cleanup failed', cause),
        )
    },
    [root, reviewId],
  )

  const scan = async () => {
    const epoch = ++requestEpoch.current
    setSnapshot(undefined)
    setEvidence(undefined)
    setSelection(undefined)
    setState('loading')
    setError(undefined)
    try {
      const result = await window.hvir.invoke('architecture-review:scan', {
        root,
        mode,
        reviewId,
        ...(mode === 'commit' ? { revision: revision.trim() } : {}),
      })
      if (epoch !== requestEpoch.current) return
      setSnapshot(result)
      setState('ready')
    } catch (cause) {
      if (epoch !== requestEpoch.current) return
      setState('error')
      setError(
        cause instanceof Error
          ? cause.message
          : 'Architecture review could not be loaded.',
      )
    }
  }
  const openEvidence = async (path: string, line: number, side: 'before' | 'after') => {
    if (!snapshot) return
    const epoch = ++requestEpoch.current
    setSelection({ path, line, side })
    setEvidence(undefined)
    setError(undefined)
    try {
      const request = {
        root,
        reviewId,
        snapshotId: snapshot.id,
        path: joinHostPath(root, path),
      }
      const captured = await window.hvir.invoke('architecture-review:evidence', {
        ...request,
        capturedOnly: true,
      })
      if (epoch !== requestEpoch.current) return
      setEvidence(captured)
      const checked = await window.hvir.invoke('architecture-review:evidence', request)
      if (epoch === requestEpoch.current) setEvidence(checked)
    } catch (cause) {
      if (epoch === requestEpoch.current)
        setError(cause instanceof Error ? cause.message : 'Evidence could not be loaded.')
    }
  }
  return (
    <section
      className="architecture-review"
      aria-label="Architecture review"
      hidden={!active}
    >
      <header className="architecture-review-header">
        <div>
          <h2>Architecture review</h2>
          <p>Captured source relationships grouped by directory.</p>
        </div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={state === 'loading' || (mode === 'commit' && !revision.trim())}
        >
          {state === 'loading' ? 'Scanning…' : 'Scan snapshot'}
        </button>
      </header>
      <div
        className="architecture-review-controls"
        role="group"
        aria-label="Baseline selection"
      >
        <label>
          Baseline
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as ArchitectureComparisonMode)
            }
          >
            {MODES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        {mode === 'commit' ? (
          <label>
            Revision
            <input
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              placeholder="commit SHA"
            />
          </label>
        ) : null}
      </div>
      {error ? (
        <p className="architecture-review-state error" role="alert">
          {error}
        </p>
      ) : null}
      {state === 'idle' && (
        <p className="architecture-review-state">
          Choose a baseline and scan to capture a review.
        </p>
      )}
      {state === 'ready' && snapshot && (
        <>
          <details className="architecture-review-metadata">
            <summary>
              {snapshot.mode} · {snapshot.analysis.modules.length} captured files ·
              Snapshot details
            </summary>
            <dl>
              <div>
                <dt>Snapshot</dt>
                <dd>{snapshot.id}</dd>
              </div>
              <div>
                <dt>Baseline</dt>
                <dd>{snapshot.baselineRevision}</dd>
              </div>
              <div>
                <dt>Current</dt>
                <dd>{snapshot.currentRevision}</dd>
              </div>
              <div>
                <dt>Fingerprint</dt>
                <dd>{snapshot.fingerprint}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>{snapshot.capturedAt}</dd>
              </div>
              <div>
                <dt>Excluded</dt>
                <dd>{snapshot.exclusions.join(', ') || 'None'}</dd>
              </div>
            </dl>
            {(['before', 'after'] as const).map(
              (side) =>
                snapshot.analysis[side].diagnostics.length > 0 && (
                  <div key={side}>
                    <strong>
                      {side}: {snapshot.analysis[side].diagnostics.length} analysis
                      notices
                    </strong>
                    <ul>
                      {snapshot.analysis[side].diagnostics
                        .slice(0, 20)
                        .map((notice, index) => (
                          <li key={index}>
                            {notice.file}:{notice.line} — {notice.message}
                          </li>
                        ))}
                    </ul>
                    {snapshot.analysis[side].diagnostics.length > 20 && (
                      <p>Showing the first 20 notices.</p>
                    )}
                  </div>
                ),
            )}
          </details>
          <p className="architecture-review-scope">
            TypeScript/JavaScript imports only. Directory grouping is structural; compiler
            aliases and package exports may be unresolved. See snapshot details for
            analysis notices.
          </p>
          <div className="architecture-review-body">
            {snapshot.analysis.modules.length === 0 ? (
              <p className="architecture-review-state">
                No supported TypeScript or JavaScript modules were captured.
              </p>
            ) : (
              <ArchitectureMap
                analysis={snapshot.analysis}
                mode={mapMode}
                onMode={setMapMode}
                onEvidence={(path, line, side) => void openEvidence(path, line, side)}
              />
            )}
            {evidence && selection ? (
              <ArchitectureEvidencePanel
                key={`${snapshot.id}:${selection.path}`}
                root={root}
                reviewId={reviewId}
                snapshot={snapshot}
                path={selection.path}
                evidence={evidence}
                freshnessError={error}
                location={selection}
              />
            ) : (
              <p className="architecture-review-state">
                {selection
                  ? 'Loading captured evidence…'
                  : 'Select a module or relationship to inspect its captured diff.'}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
