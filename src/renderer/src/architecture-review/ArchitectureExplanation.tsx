import { useEffect, useRef, useState } from 'react'
import {
  hostPathEquals,
  type ArchitectureExplanationName,
  type ArchitectureExplanationState,
  type HarnessProfile,
  type HarnessProfileId,
  type HostPath,
} from '../../../shared'
import type {
  ArchitecturePreparedExplanation,
  ArchitectureReviewSnapshot,
} from '../../../shared/architecture-review'
import { queueArchitectureAgentLaunch } from './architecture-review-launch'

export function ArchitectureExplanation({
  root,
  reviewId,
  snapshot,
  onHandoff,
}: {
  readonly root: HostPath
  readonly reviewId: string
  readonly snapshot: ArchitectureReviewSnapshot
  readonly onHandoff: (projectId: string, workspaceId: string) => void
}) {
  const epoch = useRef(0)
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [profileId, setProfileId] = useState<HarnessProfileId>()
  const [prepared, setPrepared] = useState<ArchitecturePreparedExplanation>()
  const [state, setState] = useState<ArchitectureExplanationState>()
  const [busy, setBusy] = useState<'preparing' | 'launching'>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let disposed = false
    const request = { root, reviewId, snapshotId: snapshot.id }
    void Promise.all([
      window.hvir.invoke('harness:catalog', undefined),
      window.hvir.invoke('harness:profiles', { root }),
      window.hvir.invoke('architecture-review:explanation', request),
    ])
      .then(([providers, catalog, explanation]) => {
        if (disposed) return
        setProfiles(
          (catalog ?? []).filter(
            (profile) =>
              (providers ?? []).some(
                (provider) =>
                  provider.id === profile.providerId && provider.architectureReviewLaunch,
              ) &&
              profile.executable.kind === 'provider-default' &&
              profile.args.length === 0,
          ),
        )
        setState(explanation ?? undefined)
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Architecture explanation could not be loaded.',
          )
      })
    const disposeEvent = window.hvir.on(
      'architecture-review:explanation-changed',
      (event) => {
        if (
          event.reviewId === reviewId &&
          event.snapshotId === snapshot.id &&
          hostPathEquals(event.root, root)
        )
          setState(event.state)
      },
    )
    return () => {
      disposed = true
      epoch.current += 1
      void Promise.resolve(disposeEvent()).catch((cause: unknown) =>
        console.error('Architecture explanation event cleanup failed', cause),
      )
    }
  }, [reviewId, root, snapshot.id])

  const prepare = async () => {
    const request = ++epoch.current
    setBusy('preparing')
    setPrepared(undefined)
    setError(undefined)
    try {
      const result = await window.hvir.invoke('architecture-review:prepare-explanation', {
        root,
        reviewId,
        snapshotId: snapshot.id,
      })
      if (request === epoch.current) setPrepared(result)
    } catch (cause) {
      if (request === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Explanation handoff could not be prepared.',
        )
    } finally {
      if (request === epoch.current) setBusy(undefined)
    }
  }

  const launch = async () => {
    const profile = profiles.find((candidate) => candidate.id === profileId)
    if (!prepared || !profile || busy) return
    const request = ++epoch.current
    setBusy('launching')
    setError(undefined)
    try {
      const handoff = await window.hvir.invoke(
        'architecture-review:handoff-explanation',
        {
          root: prepared.root,
          reviewId: prepared.reviewId,
          snapshotId: prepared.snapshotId,
          digest: prepared.digest,
        },
      )
      queueArchitectureAgentLaunch({
        launch: handoff.launch,
        profileId: profile.id,
        launchRevision: profile.launchRevision,
      })
      setState({ status: 'waiting', snapshotId: snapshot.id })
      onHandoff(handoff.projectId, handoff.workspaceId)
    } catch (cause) {
      if (request !== epoch.current) return
      setPrepared(undefined)
      setError(
        cause instanceof Error
          ? cause.message
          : 'Explanation worktree could not be created.',
      )
    } finally {
      if (request === epoch.current) setBusy(undefined)
    }
  }

  return (
    <section className="architecture-explanation" aria-label="Agent explanation claim">
      <header>
        <div>
          <h3>Explanation</h3>
          <p>Agent claim, checked against snapshot names</p>
        </div>
        <button type="button" onClick={() => void prepare()} disabled={!!busy}>
          {busy === 'preparing' ? 'Preparing…' : 'Explain this change'}
        </button>
      </header>
      {prepared && (
        <div className="architecture-explanation-launch">
          <p>
            New worktree <code>{prepared.handoff.worktree.path}</code> on{' '}
            <code>{prepared.handoff.branch}</code>
          </p>
          <label>
            Explanation profile{' '}
            <select
              value={profileId ?? ''}
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
            onClick={() => void launch()}
            disabled={!profileId || !!busy}
          >
            {busy === 'launching' ? 'Launching…' : 'Create worktree and launch agent'}
          </button>
        </div>
      )}
      {state?.status === 'waiting' && <p role="status">Waiting for the agent claim…</p>}
      {state?.status === 'invalid' && (
        <p className="architecture-explanation-invalid" role="alert">
          The agent claim is invalid: {state.message}
        </p>
      )}
      {state?.status === 'ready' && (
        <div className="architecture-explanation-claim">
          <h4>What changed</h4>
          <p>{state.explanation.claim.whatChanged}</p>
          <h4>Why</h4>
          <p>{state.explanation.claim.why}</p>
          <h4>Sequence</h4>
          <pre>{state.explanation.claim.sequenceDiagram}</pre>
          <h4>Touched names</h4>
          <NameList label="Systems" names={state.explanation.names.systems} />
          <NameList label="Subsystems" names={state.explanation.names.subsystems} />
          <NameList label="Modules" names={state.explanation.names.modules} />
        </div>
      )}
      {prepared && profiles.length === 0 && (
        <p role="status">No native architecture-review profile is available.</p>
      )}
      {error && (
        <p className="architecture-review-state error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function NameList({
  label,
  names,
}: {
  readonly label: string
  readonly names: readonly ArchitectureExplanationName[]
}) {
  return (
    <div className="architecture-explanation-names">
      <strong>{label}</strong>
      {names.length === 0 ? (
        <span>None claimed</span>
      ) : (
        <ul>
          {names.map((entry) => (
            <li key={entry.name} className={entry.present ? undefined : 'absent'}>
              <code>{entry.name}</code>
              {!entry.present && <span>Not found in snapshot</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
