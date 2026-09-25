import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ArchitectureAnalysis } from '../../../shared'
import {
  architectureCanvasElements,
  subsystemMap,
  type ArchitectureMapMode,
} from './architecture-review-model'
import { ArchitectureRelationships } from './ArchitectureRelationships'
import { useArchitectureLayout } from './use-architecture-layout'
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
  const [all, setAll] = useState(false)
  const [selectedSystem, setSelectedSystem] = useState<string>()
  const [selectedSubsystem, setSelectedSubsystem] = useState<string>()
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
  const elements = useMemo(
    () => architectureCanvasElements(map, mode, selectedSystem, selectedSubsystem),
    [map, mode, selectedSystem, selectedSubsystem],
  )
  const layoutInput = useMemo(
    () =>
      architectureCanvasElements(map, 'overlay', selectedSystem, selectedSubsystem)
        .layout,
    [map, selectedSystem, selectedSubsystem],
  )
  const layout = useArchitectureLayout(layoutInput)
  const nodes = useMemo<readonly Node[]>(
    () =>
      elements.nodes.map((node, index) => ({
        id: node.id,
        position: layout.positions.get(node.id) ?? {
          x: (index % 2) * 288,
          y: Math.floor(index / 2) * 96,
        },
        data: {
          label: (
            <>
              <strong>{node.label}</strong>
              <span>{node.detail}</span>
            </>
          ),
        },
        className: [
          'architecture-canvas-node',
          `architecture-canvas-${node.kind}`,
          `change-${node.change}`,
          node.ghost ? 'ghost' : '',
          node.nearby ? 'nearby' : '',
          selectedSystem === node.label || selectedSubsystem === node.id
            ? 'selected'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        draggable: false,
        selectable: true,
        ariaLabel: `${node.kind} ${node.label}, ${node.detail}`,
      })),
    [elements.nodes, layout.positions, selectedSubsystem, selectedSystem],
  )
  const edges = useMemo<readonly Edge[]>(
    () =>
      elements.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        className: `architecture-canvas-edge change-${edge.change}${edge.ghost ? ' ghost' : ''}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        selectable: Boolean(edge.relationship),
        ariaLabel: edge.relationship
          ? `${edge.relationship.source} to ${edge.relationship.target}, ${edge.change}`
          : undefined,
      })),
    [elements.edges],
  )
  const node = map.nodes.find((n) => n.id === selectedSubsystem)
  const links = map.relationships.filter(
    (r) =>
      !selectedSubsystem ||
      r.source === selectedSubsystem ||
      r.target === selectedSubsystem,
  )
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
          All systems
        </label>
      </div>
      <p className="architecture-map-note">
        Each top-level node is a system. Select a system to expand its subsystems, then a
        subsystem to expand its modules. Lines are observed imports, not responsibility
        claims.
      </p>
      {map.nodes.length === 0 ? (
        <p>
          No source changes in this comparison. Enable All systems to explore the captured
          files.
        </p>
      ) : null}
      <div className="architecture-map-canvas" aria-label="Architecture canvas">
        <ReactFlow
          nodes={[...nodes]}
          edges={[...edges]}
          fitView
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          onNodeClick={(_, clicked) => {
            const canvasNode = elements.nodes.find((item) => item.id === clicked.id)
            if (canvasNode?.path) {
              openEvidence(
                canvasNode.path,
                1,
                mode === 'before' || canvasNode.change === 'removed' ? 'before' : 'after',
              )
            } else if (canvasNode?.kind === 'system') {
              const next =
                selectedSystem === canvasNode.label ? undefined : canvasNode.label
              setSelectedSystem(next)
              setSelectedSubsystem(undefined)
            } else if (canvasNode?.kind === 'subsystem') {
              setSelectedSubsystem(
                selectedSubsystem === clicked.id ? undefined : clicked.id,
              )
            }
          }}
          onEdgeClick={(_, clicked) => {
            const relationship = elements.edges.find(
              (item) => item.id === clicked.id,
            )?.relationship
            if (relationship) setSelectedSubsystem(relationship.source)
          }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {layout.error ? <p role="alert">Layout unavailable: {layout.error}</p> : null}
      {map.omittedNodes || map.omittedRelationships ? (
        <p role="status">
          Map limit: {map.omittedNodes} additional subsystems and{' '}
          {map.omittedRelationships} relationships omitted. All captured files remain
          available below.
        </p>
      ) : null}
      <ArchitectureRelationships
        relationships={links}
        mode={mode}
        subsystem={node?.id}
        onEvidence={openEvidence}
      />
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
