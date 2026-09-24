import type { ArchitecturePreparedReview } from '../../../shared/architecture-review'

/** Everything the handoff will create, shown before anything is created. */
export function ArchitectureHandoffPreview({
  prepared,
}: {
  readonly prepared: ArchitecturePreparedReview
}) {
  const { handoff } = prepared
  return (
    <div className="architecture-handoff-preview">
      <dl>
        <div>
          <dt>New branch</dt>
          <dd>{handoff.branch}</dd>
        </div>
        <div>
          <dt>Worktree</dt>
          <dd>{handoff.worktree.path}</dd>
        </div>
        <div>
          <dt>Starts at</dt>
          <dd>{handoff.commit}</dd>
        </div>
      </dl>
      <pre aria-label="Exact agent prompt">{prepared.body}</pre>
      <details>
        <summary>Snapshot brief (untracked, excluded through info/exclude)</summary>
        <pre aria-label="Snapshot brief">{handoff.brief}</pre>
      </details>
    </div>
  )
}
