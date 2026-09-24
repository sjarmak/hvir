import { useEffect, useRef, useState } from 'react'
import {
  joinHostPath,
  type HarnessProfile,
  type HarnessProfileId,
  type HostPath,
} from '../../../shared'
import type {
  ArchitectureEvidence,
  ArchitecturePreparedReview,
  ArchitectureReviewSnapshot,
} from '../../../shared/architecture-review'
import { DiffView } from '../viewer/DiffView'
import {
  initialViewerPosition,
  type ViewerPositionCapture,
} from '../viewer/viewer-position'
import { dispatchArchitectureReviewLaunch } from './architecture-review-launch'
import { ArchitectureFindingForm } from './ArchitectureFindingForm'

const registerFindTarget = () => () => undefined
const ignorePosition = () => undefined

/** Mounted per captured file, so pending prompt work cannot outlive its evidence. */
export function ArchitectureEvidencePanel({
  root,
  reviewId,
  snapshot,
  path,
  evidence,
  freshnessError,
  location,
}: {
  readonly root: HostPath
  readonly reviewId: string
  readonly snapshot: ArchitectureReviewSnapshot
  readonly path: string
  readonly freshnessError?: string
  readonly evidence: ArchitectureEvidence
  readonly location?: { readonly line: number; readonly side: 'before' | 'after' }
}) {
  const epoch = useRef(0)
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [profileId, setProfileId] = useState<HarnessProfileId>()
  const [prepared, setPrepared] = useState<ArchitecturePreparedReview>()
  const [status, setStatus] = useState<'idle' | 'preparing' | 'launching' | 'launched'>(
    'idle',
  )
  const [error, setError] = useState<string>()
  const [position] = useState(() => initialViewerPosition('diff'))
  const [capture] = useState<ViewerPositionCapture>(() => ({ current: undefined }))
  useEffect(() => {
    let disposed = false
    void Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root }),
    ])
      .then(([providers, catalog]) => {
        if (disposed) return
        setProfiles(
          catalog.filter(
            (profile) =>
              providers.some(
                (provider) =>
                  provider.id === profile.providerId && provider.architectureReviewLaunch,
              ) &&
              profile.executable.kind === 'provider-default' &&
              profile.args.length === 0,
          ),
        )
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Harness profiles could not be loaded.',
          )
      })
    return () => {
      disposed = true
      epoch.current += 1
    }
  }, [root])

  const prepare = async () => {
    const request = ++epoch.current
    setStatus('preparing')
    setError(undefined)
    setPrepared(undefined)
    try {
      const result = await window.hvir.invoke('architecture-review:prepare', {
        root,
        reviewId,
        snapshotId: snapshot.id,
        path: joinHostPath(root, path),
      })
      if (request === epoch.current) {
        setPrepared(result)
        setStatus('idle')
      }
    } catch (cause) {
      if (request !== epoch.current) return
      setStatus('idle')
      setError(
        cause instanceof Error ? cause.message : 'Review prompt could not be prepared.',
      )
    }
  }
  const launch = async () => {
    const profile = profiles.find((candidate) => candidate.id === profileId)
    if (!prepared || !profile || status !== 'idle') return
    const request = ++epoch.current
    setStatus('launching')
    const accepted = await dispatchArchitectureReviewLaunch({
      root,
      launch: {
        root: prepared.root,
        reviewId: prepared.reviewId,
        snapshotId: prepared.snapshotId,
        path: prepared.path,
        digest: prepared.digest,
      },
      profileId: profile.id,
      launchRevision: profile.launchRevision,
    })
    if (request !== epoch.current) return
    setStatus(accepted ? 'launched' : 'idle')
    if (!accepted) setError('That review profile is unavailable for this workspace.')
  }
  return (
    <aside className="architecture-evidence" aria-label={`Captured evidence for ${path}`}>
      {evidence.stale === null && (
        <p className="architecture-review-state" role="status">
          {freshnessError
            ? 'Snapshot freshness could not be checked. Refresh the review before taking action.'
            : 'Checking snapshot freshness… You can read the captured diff while this finishes.'}
        </p>
      )}
      {evidence.stale === true && (
        <p className="architecture-review-stale" role="status">
          This capture is stale. Refresh the review before relying on this evidence.
        </p>
      )}
      <h3>{path}</h3>
      <DiffView
        path={evidence.diff.path}
        base={evidence.diff.base}
        revision={evidence.diff.revision}
        currentContent={evidence.diff.currentInput.content}
        currentSize={evidence.diff.currentInput.byteLength}
        dirty={false}
        documentRefreshVersion={0}
        gitRefreshVersion={0}
        position={position}
        onPosition={ignorePosition}
        positionCapture={capture}
        registerFindTarget={registerFindTarget}
        capturedInputs={evidence.diff}
        evidenceLocation={location}
      />
      <div className="architecture-review-launch">
        <label>
          Review profile{' '}
          <select
            value={profileId ?? ''}
            disabled={status === 'launched'}
            onChange={(event) => setProfileId(event.target.value as HarnessProfileId)}
          >
            <option value="">Select a native profile</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void prepare()}
          disabled={evidence.stale !== false || status !== 'idle'}
        >
          {status === 'preparing'
            ? 'Preparing…'
            : prepared
              ? 'Refresh exact prompt'
              : 'Prepare exact prompt'}
        </button>
        {prepared && (
          <>
            <pre aria-label="Exact review prompt">{prepared.body}</pre>
            <button
              type="button"
              onClick={() => void launch()}
              disabled={!profileId || evidence.stale !== false || status !== 'idle'}
            >
              {status === 'launched'
                ? 'Review session requested'
                : status === 'launching'
                  ? 'Launching…'
                  : 'Launch review agent'}
            </button>
          </>
        )}
        {profiles.length === 0 && (
          <p role="status">No native architecture-review profile is available.</p>
        )}
        {status === 'launched' && (
          <p role="status">
            The separate terminal session owns launch progress. Refresh the snapshot to
            start another review.
          </p>
        )}
        {error && (
          <p className="architecture-review-state error" role="alert">
            {error}
          </p>
        )}
      </div>
      <ArchitectureFindingForm
        root={root}
        snapshot={snapshot}
        path={path}
        evidence={evidence}
      />
    </aside>
  )
}
