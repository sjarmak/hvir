import type { ReactElement } from 'react'
import { beadEvalLink } from './bead-eval-links'

export function BeadEvalDetail({
  metadata,
}: {
  readonly metadata: Readonly<Record<string, string>> | undefined
}): ReactElement | null {
  const result = beadEvalLink(metadata)
  if (result.kind === 'absent') return null
  if (result.kind === 'invalid') {
    return (
      <p className="beads-field-value">
        Evaluation link unavailable: invalid or missing HTTPS run URL.
      </p>
    )
  }
  return (
    <section className="beads-field" aria-label="Evaluation result">
      <span className="beads-field-label">Evaluation result</span>
      <p className="beads-field-value">
        <a href={result.url} target="_blank" rel="noopener noreferrer" title={result.url}>
          Open run/result
        </a>{' '}
        ({result.origin})
      </p>
      <p className="beads-field-value">Producer-supplied. Current result not verified.</p>
      {result.facts.map(({ label, value }) => (
        <p className="beads-field-value" key={label}>
          {label}: {value}
        </p>
      ))}
      {result.invalidFields.length > 0 ? (
        <p className="beads-field-value">
          Invalid metadata: {result.invalidFields.join(', ')}.
        </p>
      ) : null}
    </section>
  )
}
