import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import type { ArchitectureAnalysis, ArchitectureRelationshipDelta } from '../../../shared'
import { subsystemMap, type ArchitectureMapMode } from './architecture-review-model'
import { ArchitectureRelationships } from './ArchitectureRelationships'
interface Props {
  readonly analysis: ArchitectureAnalysis
  readonly mode: ArchitectureMapMode
  readonly onMode: (mode: ArchitectureMapMode) => void
  readonly onEvidence: (path: string, line: number, side: 'before' | 'after') => void
}
export function ArchitectureMap({
  analysis,
  mode,
  onMode,
  onEvidence,
}: Props): ReactElement {
  const markerId = useId()
  const [all, setAll] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const mapElement = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (expanded && mapElement.current) mapElement.current.scrollTop = 0
  }, [expanded])
  const openEvidence = (path: string, line: number, side: 'before' | 'after') => {
    setExpanded(false)
    onEvidence(path, line, side)
  }
  const map = useMemo(() => subsystemMap(analysis, all), [analysis, all])
  const node = map.nodes.find((n) => n.id === selected)
  const links = map.relationships.filter(
    (r) => !selected || r.source === selected || r.target === selected,
  )
  const height = Math.max(104, Math.ceil(map.nodes.length / 2) * 104 + 16)
  const present = (r: ArchitectureRelationshipDelta) =>
    mode === 'overlay' || (mode === 'before' ? r.before > 0 : r.after > 0)
  return (
    <div
      ref={mapElement}
      className={`architecture-review-map${expanded ? ' architecture-map-expanded' : ''}`}
      aria-label="Module relationship map"
    >
      <div
        className="architecture-review-map-tabs"
        role="group"
        aria-label="Map comparison"
      >
        <button
          type="button"
          className="architecture-map-size-control"
          aria-label={expanded ? 'Collapse architecture map' : 'Expand architecture map'}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse map' : 'Expand map'}
        </button>
        {(['overlay', 'before', 'after'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            className={mode === value ? 'active' : ''}
            onClick={() => onMode(value)}
          >
            {value}
          </button>
        ))}
        <label>
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => setAll(event.target.checked)}
          />
          All subsystems
        </label>
      </div>
      <p className="architecture-map-note">
        Each node is a subsystem. Lines are observed imports between subsystems, not
        responsibility claims. Select a subsystem to narrow the relationships and list its
        modules.
      </p>
      {map.nodes.length === 0 ? (
        <p>
          No source changes in this comparison. Enable All subsystems to explore the
          captured files.
        </p>
      ) : null}
      <div className="architecture-map-scroll">
        <div className="architecture-map-canvas" style={{ height }}>
          <svg width="580" height={height} aria-hidden="true">
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {map.relationships.filter(present).map((r) => {
              const from = map.nodes.find((n) => n.id === r.source)!
              const to = map.nodes.find((n) => n.id === r.target)!
              return (
                <path
                  key={JSON.stringify([r.source, r.target])}
                  className={`architecture-map-edge change-${r.change}`}
                  d={`M ${from.x + 122} ${from.y + 60} C ${from.x + 122} ${from.y + 92}, ${to.x + 122} ${to.y - 22}, ${to.x + 122} ${to.y}`}
                  markerEnd={`url(#${markerId})`}
                />
              )
            })}
          </svg>
          {map.nodes.map((n) => {
            const absent =
              n.modules.length > 0 &&
              n.modules.every((m) =>
                mode === 'before'
                  ? m.change === 'added'
                  : mode === 'after'
                    ? m.change === 'removed'
                    : false,
              )
            return (
              <button
                key={n.id}
                type="button"
                className={`architecture-subsystem ${n.nearby ? 'nearby' : ''} ${absent ? 'absent' : ''}`}
                style={{ left: n.x, top: n.y }}
                aria-pressed={selected === n.id}
                onClick={() => setSelected(selected === n.id ? undefined : n.id)}
              >
                <strong>{n.id}</strong>
                <span>
                  {absent
                    ? `Absent ${mode}`
                    : n.modules.length
                      ? `${n.changed} changed · ${n.modules.length} files`
                      : 'External or unresolved import'}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {map.omittedNodes || map.omittedRelationships ? (
        <p role="status">
          Map limit: {map.omittedNodes} additional subsystems and{' '}
          {map.omittedRelationships} relationships omitted. All captured files remain
          available below.
        </p>
      ) : null}
      <ArchitectureRelationships
        relationships={links.filter(present)}
        mode={mode}
        subsystem={node?.id}
        onEvidence={openEvidence}
      />
      {node ? (
        <section
          className="architecture-module-list"
          aria-label={`Modules in ${node.id}`}
        >
          <h3>{node.id}</h3>
          <ModuleGroups
            modules={node.modules.slice(0, 200)}
            mode={mode}
            onEvidence={openEvidence}
          />
          {node.modules.length > 200 ? (
            <p>Showing 200 files. Use file search below for the rest.</p>
          ) : null}
        </section>
      ) : null}
      <ArchitectureFiles analysis={analysis} mode={mode} onEvidence={openEvidence} />
    </div>
  )
}
function ArchitectureFiles({
  analysis,
  mode,
  onEvidence,
}: Pick<Props, 'analysis' | 'mode' | 'onEvidence'>): ReactElement {
  const [query, setQuery] = useState('')
  const files = analysis.modules.filter((m) =>
    m.path.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <details className="architecture-file-explorer">
      <summary>All captured files ({analysis.modules.length})</summary>
      <label>
        Filter files{' '}
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ModuleGroups modules={files.slice(0, 100)} mode={mode} onEvidence={onEvidence} />
      {files.length > 100 ? (
        <p>Showing 100 of {files.length}; narrow the filter.</p>
      ) : null}
    </details>
  )
}

function ModuleGroups({
  modules,
  mode,
  onEvidence,
}: {
  readonly modules: readonly ArchitectureAnalysis['modules'][number][]
  readonly mode: ArchitectureMapMode
  readonly onEvidence: Props['onEvidence']
}): ReactElement {
  const groups = [
    {
      key: 'changed',
      title: 'Changed files',
      files: modules.filter((module) => module.change !== 'unchanged'),
    },
    {
      key: 'unchanged',
      title: 'Unchanged files',
      files: modules.filter((module) => module.change === 'unchanged'),
    },
  ] as const
  return (
    <>
      {groups.map((group) =>
        group.files.length ? (
          <section
            key={group.key}
            className={`architecture-file-group ${group.key}`}
            aria-label={`${group.title} (${group.files.length})`}
          >
            <h4>
              {group.title} <small>({group.files.length})</small>
            </h4>
            {group.files.map((module) => (
              <button
                type="button"
                key={module.path}
                className={`architecture-module change-${module.change}`}
                onClick={() =>
                  onEvidence(
                    module.path,
                    1,
                    mode === 'before' || module.change === 'removed' ? 'before' : 'after',
                  )
                }
              >
                <span>{module.path}</span>
                <small>{moduleChangeLabel(module.change)}</small>
              </button>
            ))}
          </section>
        ) : null,
      )}
    </>
  )
}

function moduleChangeLabel(change: ArchitectureAnalysis['modules'][number]['change']) {
  switch (change) {
    case 'added':
      return 'Added'
    case 'removed':
      return 'Removed'
    case 'changed':
      return 'Changed'
    default:
      return 'Unchanged'
  }
}
