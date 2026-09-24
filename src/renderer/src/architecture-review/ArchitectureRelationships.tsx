import type { ReactElement } from 'react'
import type {
  ArchitectureImportDelta,
  ArchitectureRelationshipDelta,
} from '../../../shared'
import { evidenceByModule, type ArchitectureMapMode } from './architecture-review-model'

const EVIDENCE_LIMIT = 100

interface Props {
  readonly relationships: readonly ArchitectureRelationshipDelta[]
  readonly mode: ArchitectureMapMode
  /** The subsystem the list is narrowed to, if any. */
  readonly subsystem?: string
  readonly onEvidence: (path: string, line: number, side: 'before' | 'after') => void
}

/** Subsystem relationships first; each opens onto its modules, then their imports. */
export function ArchitectureRelationships({
  relationships,
  mode,
  subsystem,
  onEvidence,
}: Props): ReactElement {
  return (
    <section
      className="architecture-review-relationships"
      aria-label="Subsystem relationships"
    >
      <h3>Subsystem relationships{subsystem ? ` involving ${subsystem}` : ''}</h3>
      {relationships.map((r) => (
        <details
          key={JSON.stringify([r.source, r.target])}
          className={`architecture-relationship change-${r.change}`}
        >
          <summary>
            {r.source} → {r.target}
            <small>
              {relationshipLabel(r.change)} · {r.before} before / {r.after} after
            </small>
          </summary>
          <RelationshipEvidence relationship={r} mode={mode} onEvidence={onEvidence} />
        </details>
      ))}
    </section>
  )
}

function RelationshipEvidence({
  relationship,
  mode,
  onEvidence,
}: {
  readonly relationship: ArchitectureRelationshipDelta
  readonly mode: ArchitectureMapMode
  readonly onEvidence: Props['onEvidence']
}): ReactElement {
  const visible = relationship.evidence.filter(
    (e) =>
      mode === 'overlay' ||
      (mode === 'before' ? e.change !== 'added' : e.change !== 'removed'),
  )
  const { modules, omitted } = evidenceByModule(visible, EVIDENCE_LIMIT)
  return (
    <>
      {modules.map(({ module, imports }) => (
        <section
          key={module}
          className="architecture-evidence-module"
          aria-label={`Imports in ${module}`}
        >
          <h4>
            {module} <small>({imports.length})</small>
          </h4>
          {imports.map((e, index) => (
            <ImportButton key={index} fact={e} mode={mode} onEvidence={onEvidence} />
          ))}
        </section>
      ))}
      {omitted > 0 ? <p>{omitted} more imports in this relationship.</p> : null}
    </>
  )
}

function ImportButton({
  fact,
  mode,
  onEvidence,
}: {
  readonly fact: ArchitectureImportDelta
  readonly mode: ArchitectureMapMode
  readonly onEvidence: Props['onEvidence']
}): ReactElement {
  const line = mode === 'before' ? (fact.beforeLine ?? fact.line) : fact.line
  const side = mode === 'before' || fact.change === 'removed' ? 'before' : 'after'
  return (
    <button type="button" onClick={() => onEvidence(fact.source, line, side)}>
      line {line} · {fact.specifier}{' '}
      <small>
        {fact.change} · {fact.kind} · {fact.resolution}
      </small>
    </button>
  )
}

function relationshipLabel(change: ArchitectureRelationshipDelta['change']): string {
  switch (change) {
    case 'added':
      return 'New dependency'
    case 'removed':
      return 'Removed dependency'
    case 'changed':
      return 'Imports changed, existing dependency'
    default:
      return 'Context'
  }
}
