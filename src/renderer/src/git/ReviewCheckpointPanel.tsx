import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type {
  ReviewCheckpointChange,
  ReviewCheckpointDiff,
  ReviewCheckpointRequest,
  ReviewCheckpointResult,
  ReviewCheckpointStatus,
} from '../../../shared'
import type { HostConnectionState, HostPath } from '../../../shared'
import { DiffView } from '../viewer/DiffView'
import type { ViewerDocumentPosition } from '../viewer/tab-state'

interface ReviewCheckpointPanelProps {
  readonly root: HostPath
  readonly connectionState: HostConnectionState
  readonly visible: boolean
}

type RunResult =
  | { readonly accepted: true; readonly value: ReviewCheckpointResult }
  | { readonly accepted: false }

export function ReviewCheckpointPanel({
  root,
  connectionState,
  visible,
}: ReviewCheckpointPanelProps): ReactElement {
  const [status, setStatus] = useState<ReviewCheckpointStatus | undefined>(undefined)
  const [selected, setSelected] = useState<ReviewCheckpointChange | undefined>(undefined)
  const [diff, setDiff] = useState<ReviewCheckpointDiff | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const generation = useRef(0)
  const operation = useRef<string | undefined>(undefined)

  const cancel = useCallback((): void => {
    const id = operation.current
    operation.current = undefined
    generation.current += 1
    if (!id) return
    window.hvir.send('git:review-checkpoint-cancel', { id })
  }, [])

  const run = useCallback(
    async (request: ReviewCheckpointRequest): Promise<RunResult> => {
      cancel()
      const id = crypto.randomUUID()
      const requestGeneration = generation.current
      operation.current = id
      setLoading(true)
      setError(undefined)
      try {
        const result = await window.hvir.invoke('git:review-checkpoint', {
          id,
          ...request,
        })
        if (operation.current !== id || generation.current !== requestGeneration)
          return { accepted: false }
        return { accepted: true, value: result }
      } catch (reason) {
        if (operation.current === id && generation.current === requestGeneration)
          setError(errorMessage(reason))
        return { accepted: false }
      } finally {
        if (operation.current === id) {
          operation.current = undefined
          setLoading(false)
        }
      }
    },
    [cancel],
  )

  const refresh = useCallback(async (): Promise<void> => {
    const outcome = await run({ root, action: 'status' })
    if (outcome.accepted && isStatus(outcome.value)) {
      setStatus(outcome.value)
      setSelected(undefined)
      setDiff(undefined)
    }
  }, [root, run])

  const mutate = useCallback(
    async (action: 'capture' | 'clear'): Promise<void> => {
      const outcome = await run({ root, action })
      if (outcome.accepted) await refresh()
    },
    [refresh, root, run],
  )

  const openDiff = useCallback(
    async (change: ReviewCheckpointChange): Promise<void> => {
      if (!status?.oid) return
      setSelected(change)
      setDiff(undefined)
      const outcome = await run({
        root,
        action: 'diff',
        checkpoint: status.oid,
        change,
      })
      if (outcome.accepted && isDiff(outcome.value)) setDiff(outcome.value)
    },
    [root, run, status?.oid],
  )

  useEffect(() => {
    if (!visible || connectionState !== 'connected') {
      cancel()
      setStatus(undefined)
      setSelected(undefined)
      setDiff(undefined)
      return
    }
    setStatus(undefined)
    setSelected(undefined)
    setDiff(undefined)
    setError(undefined)
    void refresh()
    return cancel
  }, [cancel, connectionState, refresh, root.hostId, root.path, visible])

  if (connectionState !== 'connected')
    return <div className="git-empty">Reconnect to inspect changes since review.</div>

  return (
    <div className="review-checkpoint-panel" aria-label="Changes since review" aria-busy={loading}>
      <div className="review-checkpoint-actions">
        <button type="button" onClick={() => void mutate('capture')} disabled={loading}>
          {status?.oid ? 'Advance checkpoint' : 'Save checkpoint'}
        </button>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void mutate('clear')}
          disabled={loading || !status?.oid}
        >
          Clear
        </button>
      </div>
      {error ? <div className="tree-error">Review checkpoint unavailable: {error}</div> : null}
      {!loading && status?.oid === null ? (
        <div className="git-empty">
          No review checkpoint saved. Save one explicitly to start tracking changes.
        </div>
      ) : null}
      {!loading && status?.oid ? (
        <div className="review-checkpoint-baseline" role="status">
          Checkpoint {status.oid} · One baseline; Advance replaces it.
        </div>
      ) : null}
      {!loading && status?.oid && status.changes.length === 0 ? (
        <div className="git-empty">No changes since this checkpoint.</div>
      ) : null}
      {status?.changes.length ? (
        <div className="review-checkpoint-files">
          {status.changes.map((change) => (
            <button
              type="button"
              className={selected === change ? 'active' : ''}
              key={`${change.path.hostId}:${change.path.path}`}
              onClick={() => void openDiff(change)}
            >
              <span>{change.path.path.slice(root.path.length + 1)}</span>
              <span>{change.before && change.after ? 'Modified' : change.after ? 'Added' : 'Deleted'}</span>
            </button>
          ))}
        </div>
      ) : null}
      {diff ? (
        <div className="review-checkpoint-diff">
          <CheckpointDiff diff={diff} />
        </div>
      ) : null}
    </div>
  )
}

function CheckpointDiff({ diff }: { readonly diff: ReviewCheckpointDiff }): ReactElement {
  const position: ViewerDocumentPosition = { mode: 'rendered', line: 1, scrollTop: 0 }
  return (
    <DiffView
      path={diff.path}
      base="head"
      currentContent={diff.currentInput.content}
      currentSize={diff.currentInput.byteLength}
      dirty={false}
      documentRefreshVersion={0}
      gitRefreshVersion={0}
      position={position}
      onPosition={() => undefined}
      positionCapture={{ current: () => position }}
      registerFindTarget={() => () => undefined}
      capturedInputs={{
        baseLabel: 'Checkpoint',
        currentLabel: 'Current',
        baseInput: diff.baseInput,
        currentInput: diff.currentInput,
      }}
    />
  )
}

function isStatus(result: ReviewCheckpointResult | undefined): result is ReviewCheckpointStatus {
  return Boolean(result && 'changes' in result && 'oid' in result)
}

function isDiff(result: ReviewCheckpointResult | undefined): result is ReviewCheckpointDiff {
  return Boolean(result && 'baseInput' in result && 'currentInput' in result)
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
