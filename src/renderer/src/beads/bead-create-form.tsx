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
  /** Resolves true once the command was typed; the field clears only then. */
  readonly onCreate: (title: string) => Promise<boolean>
  /** When set, submit is disabled and this explains why (no terminal can launch). */
  readonly disabledHint?: string
}

/**
 * Inline title field for `bd create`. Purely presentational and controlled: it
 * normalizes the title and hands it to `onCreate`, which builds and delivers
 * the command. The field is cleared through `onChange` only once the terminal
 * accepted the command, so a refused request never eats a typed title.
 */
export function BeadCreateForm({
  value,
  onChange,
  onCreate,
  disabledHint,
}: BeadCreateFormProps): ReactElement {
  const title = normalizeBeadTitle(value)
  const blocked = disabledHint !== undefined

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (title === '' || blocked) return
    void onCreate(title).then((accepted) => {
      if (accepted) onChange('')
    })
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
      <button
        type="submit"
        title={disabledHint ?? BEAD_ACTION_HINTS.create}
        disabled={title === '' || blocked}
      >
        {BEAD_ACTION_LABELS.create}
      </button>
    </form>
  )
}
