import { useRef, useState, type FormEvent, type ReactElement } from 'react'
import type {
  ArchitectureEvidence,
  ArchitectureReviewSnapshot,
} from '../../../shared/architecture-review'
import type { HostPath } from '../../../shared'
import { beadCommand } from '../beads/bead-commands'
import { dispatchBeadCommand } from '../beads/bead-launch-event'

interface Props {
  readonly root: HostPath
  readonly snapshot: ArchitectureReviewSnapshot
  readonly path: string
  readonly evidence: ArchitectureEvidence
}

export function ArchitectureFindingForm({
  root,
  snapshot,
  path,
  evidence,
}: Props): ReactElement {
  const submitted = useRef(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [side, setSide] = useState<'before' | 'after'>('after')
  const [line, setLine] = useState('')
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'error'>('idle')
  const input = side === 'before' ? evidence.diff.baseInput : evidence.diff.currentInput
  const lineCount = input.content.length === 0 ? 0 : input.content.split('\n').length
  const lineNumber = Number(line)
  const valid =
    !evidence.stale &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    Number.isInteger(lineNumber) &&
    lineNumber >= 1 &&
    lineNumber <= lineCount

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || submitted.current) return
    const description = JSON.stringify({
      body: body.trim(),
      citation: {
        root,
        path,
        side,
        line: lineNumber,
        snapshotId: snapshot.id,
        fingerprint: snapshot.fingerprint,
        baselineRevision: snapshot.baselineRevision,
        currentRevision: snapshot.currentRevision,
      },
    })
    const built = beadCommand({ action: 'create', title: title.trim(), description })
    if (!built) {
      setState('error')
      return
    }
    submitted.current = true
    setState('pending')
    const accepted = await dispatchBeadCommand(root, built.command)
    if (!accepted) submitted.current = false
    setState(accepted ? 'sent' : 'error')
  }

  return (
    <form aria-label="Create finding bead" onSubmit={(event) => void submit(event)}>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Body
        <textarea value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      <label>
        Side
        <select
          value={side}
          onChange={(event) => setSide(event.target.value as 'before' | 'after')}
        >
          <option value="before">Before</option>
          <option value="after">After</option>
        </select>
      </label>
      <label>
        Line
        <input
          inputMode="numeric"
          value={line}
          onChange={(event) => setLine(event.target.value)}
        />
      </label>
      <button type="submit" disabled={!valid || state === 'pending' || state === 'sent'}>
        {state === 'pending'
          ? 'Creating…'
          : state === 'sent'
            ? 'Bead command requested'
            : 'Create bead from finding'}
      </button>
      {state === 'sent' && (
        <p role="status">
          Check the separate terminal session for the Beads command result.
        </p>
      )}
      {state === 'error' ? (
        <p role="alert">The finding bead could not be created.</p>
      ) : null}
    </form>
  )
}
