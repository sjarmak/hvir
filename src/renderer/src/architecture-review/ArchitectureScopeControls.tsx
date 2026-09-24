import { useId } from 'react'
import { ARCHITECTURE_LAYOUT_FILE } from '../../../shared/architecture-layout'
import type { ArchitectureScopeRefusal } from '../../../shared/architecture-scope'
import {
  candidateLabel,
  scopeFromText,
  toggleScopePath,
} from './architecture-scope-model'

interface ArchitectureScopeControlsProps {
  /** Undefined until a scan has reported the scope in effect. */
  readonly text: string | undefined
  readonly refusal?: ArchitectureScopeRefusal
  readonly disabled: boolean
  readonly onText: (text: string) => void
  readonly onSave: () => void
}

/**
 * The paths a scan reads, saved to the working tree's layout file. A refusal opens it with
 * the largest paths inside the measured scope, each strictly narrower than it.
 */
export function ArchitectureScopeControls({
  text,
  refusal,
  disabled,
  onText,
  onSave,
}: ArchitectureScopeControlsProps) {
  const fieldId = useId()
  const problemId = useId()
  if (text === undefined)
    return (
      <p className="architecture-review-scope-controls">
        Scope: shown after the first scan.
      </p>
    )
  const parsed = scopeFromText(text)
  const chosen = new Set(parsed.scope)
  return (
    <details className="architecture-review-scope-controls" open={refusal !== undefined}>
      <summary>
        Scope: {parsed.scope.length ? parsed.scope.join(', ') : 'Whole repository'}
      </summary>
      <label htmlFor={fieldId}>
        Paths to scan, one per line; leave empty for the whole repository. Saved to{' '}
        {ARCHITECTURE_LAYOUT_FILE} in the working tree.
      </label>
      <textarea
        id={fieldId}
        value={text}
        rows={3}
        spellCheck={false}
        aria-invalid={parsed.problem !== undefined}
        aria-describedby={parsed.problem === undefined ? undefined : problemId}
        onChange={(event) => onText(event.target.value)}
      />
      {parsed.problem !== undefined && (
        <span id={problemId} className="architecture-review-ref-problem">
          {parsed.problem}
        </span>
      )}
      {refusal && refusal.candidates.length > 0 && (
        <fieldset>
          <legend>Largest paths in the refused scope</legend>
          {refusal.candidates.map((candidate) => (
            <label key={candidate.path}>
              <input
                type="checkbox"
                checked={chosen.has(candidate.path)}
                onChange={() => onText(toggleScopePath(text, candidate.path))}
              />
              {candidateLabel(candidate)}
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={disabled || parsed.problem !== undefined}
      >
        Save scope and scan
      </button>
    </details>
  )
}
