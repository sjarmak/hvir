import { useState, type FormEvent, type ReactElement } from 'react'

import {
  BEAD_ACTION_HINTS,
  BEAD_ACTION_LABELS,
  normalizeBeadTitle,
} from './bead-commands'

/**
 * Inline title field for `bd create`. Purely presentational: it normalizes the
 * title and hands it to `onCreate`, which builds and delivers the command.
 */
export function BeadCreateForm({
  onCreate,
}: {
  readonly onCreate: (title: string) => void
}): ReactElement {
  const [value, setValue] = useState('')
  const title = normalizeBeadTitle(value)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (title === '') return
    onCreate(title)
    setValue('')
  }

  return (
    <form className="beads-create" onSubmit={submit}>
      <input
        type="text"
        aria-label="New bead title"
        placeholder="New bead title"
        maxLength={200}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" title={BEAD_ACTION_HINTS.create} disabled={title === ''}>
        {BEAD_ACTION_LABELS.create}
      </button>
    </form>
  )
}
