import { useEffect, useRef, useState } from 'react'
import {
  type ArchitectureExplanationName,
  type ArchitectureExplanationState,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../../../shared'
import type { ArchitectureReviewSnapshot } from '../../../shared/architecture-review'
import {
  selectArchitectureReviewProfiles,
  selectArchitectureReviewTemplateProvider,
} from './architecture-review-profiles'

export function ArchitectureExplanation({
  root,
  reviewId,
  snapshot,
  collapsed,
  onCollapsedChange,
}: {
  readonly root: HostPath
  readonly reviewId: string
  readonly snapshot: ArchitectureReviewSnapshot
  readonly collapsed: boolean
  readonly onCollapsedChange: (collapsed: boolean) => void
}) {
  const epoch = useRef(0)
  const [profiles, setProfiles] = useState<readonly HarnessProfile[]>([])
  const [creationProvider, setCreationProvider] = useState<HarnessProviderDescriptor>()
  const [profileId, setProfileId] = useState<HarnessProfileId>()
  const [state, setState] = useState<ArchitectureExplanationState>()
  const [busy, setBusy] = useState<'explaining' | 'creating-profile'>()
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
        setCreationProvider(selectArchitectureReviewTemplateProvider(providers ?? []))
        const eligible = selectArchitectureReviewProfiles(providers ?? [], catalog ?? [])
        setProfiles(eligible)
        setProfileId((current) => current ?? eligible[0]?.id)
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
    return () => {
      disposed = true
      epoch.current += 1
    }
  }, [reviewId, root, snapshot.id])

  const explain = async () => {
    const profile = profiles.find((candidate) => candidate.id === profileId)
    if (!profile || busy) return
    const request = ++epoch.current
    setBusy('explaining')
    setError(undefined)
    setState({ status: 'waiting', snapshotId: snapshot.id })
    try {
      const result = await window.hvir.invoke('architecture-review:explain', {
        root,
        reviewId,
        snapshotId: snapshot.id,
        profileId: profile.id,
        launchRevision: profile.launchRevision,
      })
      if (request === epoch.current) setState(result)
    } catch (cause) {
      if (request === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Architecture explanation could not be generated.',
        )
    } finally {
      if (request === epoch.current) setBusy(undefined)
    }
  }

  const createProfile = async () => {
    if (!creationProvider || busy) return
    const request = ++epoch.current
    setBusy('creating-profile')
    setError(undefined)
    try {
      const created = await window.hvir.invoke('harness:profile-materialize', {
        root,
        providerIds: [creationProvider.id],
      })
      const [eligible] = selectArchitectureReviewProfiles([creationProvider], created)
      if (!eligible) {
        throw new Error('The created profile does not support architecture review.')
      }
      if (request === epoch.current) {
        setProfiles((current) => [...current, eligible])
        setProfileId(eligible.id)
      }
    } catch (cause) {
      if (request === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The native architecture-review profile could not be created.',
        )
    } finally {
      if (request === epoch.current) setBusy(undefined)
    }
  }

  return (
    <section className="architecture-explanation" aria-label="Agent explanation claim">
      <header>
        <h3>Explanation</h3>
        <button
          type="button"
          aria-label={
            collapsed ? 'Expand explanation panel' : 'Collapse explanation panel'
          }
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </header>
      {!collapsed && (
        <>
          <div className="architecture-explanation-intro">
            <p>Agent claim, checked against snapshot names</p>
            <button
              type="button"
              onClick={() => void explain()}
              disabled={!profileId || !!busy}
            >
              {busy === 'explaining' ? 'Explaining…' : 'Explain this change'}
            </button>
          </div>
          {profiles.length > 0 && (
            <div className="architecture-explanation-profile">
              <label>
                Explanation profile{' '}
                <select
                  value={profileId ?? ''}
                  onChange={(event) =>
                    setProfileId(event.target.value as HarnessProfileId)
                  }
                >
                  <option value="">Select a native profile</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.displayName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {state?.status === 'waiting' && (
            <p role="status">Waiting for the agent claim…</p>
          )}
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
          {profiles.length === 0 && (
            <div>
              <p>
                Architecture review requires a supported provider, its default executable,
                and no custom arguments. None of the current profiles qualify.
              </p>
              {creationProvider && (
                <button
                  type="button"
                  onClick={() => void createProfile()}
                  disabled={!!busy}
                >
                  {busy === 'creating-profile'
                    ? 'Creating profile…'
                    : `Create ${creationProvider.profileTemplate?.displayName ?? creationProvider.displayName} profile`}
                </button>
              )}
            </div>
          )}
          {error && (
            <p className="architecture-review-state error" role="alert">
              {error}
            </p>
          )}
        </>
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
