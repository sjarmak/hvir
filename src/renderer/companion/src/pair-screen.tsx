import { useState, type FormEvent } from 'react'

interface PairScreenProps {
  readonly error?: string
  readonly onPair: (code: string) => Promise<void>
}

/** Where every Companion page starts: one pairing code, typed once. */
export function PairScreen({ error, onPair }: PairScreenProps) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = code.trim()

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (trimmed === '' || busy) return
    setBusy(true)
    try {
      await onPair(trimmed)
    } finally {
      setBusy(false)
      setCode('')
    }
  }

  return (
    <main className="companion companion-pair">
      <h1 className="companion-title">hvir Companion</h1>
      <p className="companion-hint">
        Open Settings, Companion on the desktop, issue a pairing code, and type it here.
      </p>
      <form className="companion-pair-form" onSubmit={(event) => void submit(event)}>
        <label className="companion-label" htmlFor="companion-pair-code">
          Pairing code
        </label>
        <input
          id="companion-pair-code"
          className="companion-input"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button
          className="companion-button companion-button-primary"
          type="submit"
          disabled={busy}
        >
          Pair
        </button>
      </form>
      {error === undefined ? null : (
        <p className="companion-error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
