import { useState, type ReactElement } from 'react'

import { displayHostPath, type WorkspaceState } from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'

/** Confirms, then asks main to remove one unfinished handoff and its branch. */
export function RemoveUnfinishedHandoffDialog({
  projectId,
  workspace,
  onClose,
}: {
  readonly projectId: string
  readonly workspace: WorkspaceState
  readonly onClose: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function remove(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.hvir.invoke('workspace:remove-unfinished-handoff', {
        projectId,
        workspaceId: workspace.id,
      })
      if (result.ok) onClose()
      else setError(result.error)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmationDialog
      labelledBy="unfinished-handoff-title"
      actions={[
        { label: 'Cancel', kind: 'cancel', onSelect: onClose },
        {
          label: 'Remove worktree and branch',
          kind: 'destructive',
          onSelect: () => void remove(),
        },
      ]}
      busy={busy}
      className="unfinished-handoff-dialog"
    >
      <h2 id="unfinished-handoff-title">Remove unfinished handoff?</h2>
      <p>
        An architecture review handoff created this worktree and was interrupted before
        its brief was written. No agent ran in it, and it has no commits or changes.
      </p>
      <div className="worktree-prune-list">
        <div>
          <code>{displayHostPath(workspace.root)}</code>
          <small>branch {workspace.branch}</small>
        </div>
      </div>
      <p>
        hvir checks all of this again before removing anything. Git removes the worktree
        without forcing it, and the branch is deleted only if it still points at the
        commit it started from.
      </p>
      {error ? (
        <p className="worktree-prune-warning" role="alert">
          {error}
        </p>
      ) : null}
    </ConfirmationDialog>
  )
}
