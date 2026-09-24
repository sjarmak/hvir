import { useId } from 'react'
import {
  ARCHITECTURE_BRANCH_POINT,
  ARCHITECTURE_WORKING_TREE,
} from '../../../shared/architecture-review'
import type { ParsedEnds } from './architecture-ends-model'

interface ArchitectureEndsControlsProps {
  readonly baseline: string
  readonly current: string
  readonly problems: ParsedEnds['problems']
  readonly onBaseline: (text: string) => void
  readonly onCurrent: (text: string) => void
}

/** Free ref entry for both ends; a blank end is its default. */
export function ArchitectureEndsControls({
  baseline,
  current,
  problems,
  onBaseline,
  onCurrent,
}: ArchitectureEndsControlsProps) {
  return (
    <div className="architecture-review-controls" role="group" aria-label="Snapshot ends">
      <RefField
        label="Baseline"
        value={baseline}
        placeholder={ARCHITECTURE_BRANCH_POINT}
        problem={problems.baseline}
        onChange={onBaseline}
      />
      <RefField
        label="Current"
        value={current}
        placeholder={ARCHITECTURE_WORKING_TREE}
        problem={problems.current}
        onChange={onCurrent}
      />
    </div>
  )
}

function RefField({
  label,
  value,
  placeholder,
  problem,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly placeholder: string
  readonly problem?: string
  readonly onChange: (text: string) => void
}) {
  const problemId = useId()
  return (
    <label>
      {label}
      <input
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : problemId}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== undefined && (
        <span id={problemId} className="architecture-review-ref-problem">
          {problem}
        </span>
      )}
    </label>
  )
}
