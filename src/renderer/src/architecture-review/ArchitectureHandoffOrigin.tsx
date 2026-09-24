import { useEffect, useState } from 'react'
import type { HostPath } from '../../../shared'
import type { ArchitectureHandoffOrigin as Origin } from '../../../shared/architecture-handoff'
import { handoffEnds, type ArchitectureEnds } from './architecture-ends-model'

/**
 * In a worktree an agent was handed, offers the two re-snapshots its brief records: the
 * agent's change against the original Current, or the cumulative one against the Baseline.
 */
export function ArchitectureHandoffOrigin({
  root,
  disabled,
  onOrigin,
  onScan,
}: {
  readonly root: HostPath
  readonly disabled: boolean
  /** Called once with the default ends, so a plain scan shows the agent's change. */
  readonly onOrigin: (ends: ArchitectureEnds) => void
  readonly onScan: (ends: ArchitectureEnds) => void
}) {
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let disposed = false
    window.hvir
      .invoke('architecture-review:origin', { root })
      .then((found) => {
        if (disposed || !found) return
        setOrigin(found)
        onOrigin(handoffEnds(found, 'change'))
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : 'The handoff origin could not be read.',
          )
      })
    return () => {
      disposed = true
    }
    // The origin is read once per workspace; a later callback identity is not a new root.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])
  if (error)
    return (
      <p className="architecture-review-state error" role="alert">
        {error}
      </p>
    )
  if (!origin) return null
  return (
    <div className="architecture-handoff-origin" role="group" aria-label="Agent handoff">
      <p>
        An agent was handed this worktree from {origin.baselineRef} → {origin.currentRef}.
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onScan(handoffEnds(origin, 'change'))}
      >
        Scan the agent&apos;s change
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onScan(handoffEnds(origin, 'cumulative'))}
      >
        Scan the cumulative change
      </button>
    </div>
  )
}
