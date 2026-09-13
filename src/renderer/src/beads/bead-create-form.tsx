import type { FormEvent, ReactElement } from 'react'

import {
  BEAD_ACTION_HINTS,
  BEAD_ACTION_LABELS,
  normalizeBeadTitle,
} from './bead-commands'

interface BeadCreateFormProps {
  /** The raw field value; owned by the parent so it survives this form unmounting. */
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onCreate: (title: string) => void
}

/**
 * Inline title field for `bd create`. Purely presentational and controlled: it
 * normalizes the title and hands it to `onCreate`, which builds and delivers
 * the command, then clears the field through `onChange`.
 */
export function BeadCreateForm({ value, onChange, onCreate }: BeadCreateFormProps): ReactElement {
  const title = normalizeBeadTitle(value)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (title === '') return
    onCreate(title)
    onChange('')
  }

  return (
    <form className="beads-create" onSubmit={submit}>
      <input
        type="text"
        aria-label="New bead title"
        placeholder="New bead title"
        maxLength={200}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" title={BEAD_ACTION_HINTS.create} disabled={title === ''}>
        {BEAD_ACTION_LABELS.create}
      </button>
    </form>
  )
}
