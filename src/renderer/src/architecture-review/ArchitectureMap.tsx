import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  BaseEdge,
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  getStraightPath,
  type Edge,
  type EdgeProps,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ArchitectureAnalysis } from '../../../shared'
import {
  architectureCanvasElements,
  architectureFocusElements,
  architectureZoomLabelMode,
  moduleLabelParts,
  subsystemMap,
  type ArchitectureFocusDirection,
  type ArchitectureMapMode,
} from './architecture-review-model'
import { ArchitectureRelationships } from './ArchitectureRelationships'
import type {
  ArchitectureLayoutOrientation,
  ArchitectureLayoutSpacing,
} from './architecture-layout'
import { useArchitectureLayout } from './use-architecture-layout'
interface Props {
  readonly analysis: ArchitectureAnalysis
  readonly mode: ArchitectureMapMode
  readonly onMode: (mode: ArchitectureMapMode) => void
  readonly onEvidence: (path: string, line: number, side: 'before' | 'after') => void
}
interface ArchitectureEdgeData extends Record<string, unknown> {
  readonly points?: readonly { readonly x: number; readonly y: number }[]
}
function ArchitectureEdgeLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps<Edge<ArchitectureEdgeData>>): ReactElement {
  const points = data?.points
  const path =
    points && points.length >= 2
      ? `M ${points.map((point) => `${point.x},${point.y}`).join(' L ')}`
      : getStraightPath({ sourceX, sourceY, targetX, targetY })[0]
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
}
const edgeTypes = { architecture: ArchitectureEdgeLine }
export function ArchitectureMap({
  analysis,
  mode,
  onMode,
  onEvidence,
}: Props): ReactElement {
  const [all, setAll] = useState(false)
  const [selectedSystem, setSelectedSystem] = useState<string>()
  const [selectedSubsystem, setSelectedSubsystem] = useState<string>()
  const [focusedRelationship, setFocusedRelationship] = useState<{
    readonly source: string
    readonly target: string
  }>()
  const [showUnchangedModules, setShowUnchangedModules] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [focusSubsystem, setFocusSubsystem] = useState<string>()
  const [focusDirection, setFocusDirection] = useState<ArchitectureFocusDirection>('both')
  const [zoom, setZoom] = useState(1)
  const zoomLabelMode = architectureZoomLabelMode(zoom)
  const [layoutOrientation, setLayoutOrientation] =
    useState<ArchitectureLayoutOrientation>('horizontal')
  const [layoutSpacing, setLayoutSpacing] = useState<ArchitectureLayoutSpacing>('comfortable')
  const layoutOptions = useMemo(
    () => ({ orientation: layoutOrientation, spacing: layoutSpacing }),
    [layoutOrientation, layoutSpacing],
  )
  const mapElement = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (expanded && mapElement.current) mapElement.current.scrollTop = 0
  }, [expanded])
  const openEvidence = (path: string, line: number, side: 'before' | 'after') => {
    setExpanded(false)
    onEvidence(path, line, side)
  }
  const map = useMemo(() => subsystemMap(analysis, all), [analysis, all])
  const [moduleQuery, setModuleQuery] = useState('')
  const ownershipElements = useMemo(
    () =>
      architectureCanvasElements(
        map,
        mode,
        selectedSystem,
        selectedSubsystem,
        showUnchangedModules,
        moduleQuery,
      ),
    [map, mode, selectedSystem, selectedSubsystem, showUnchangedModules, moduleQuery],
  )
  const ownershipLayoutInput = useMemo(
    () =>
      architectureCanvasElements(
        map,
        'overlay',
        selectedSystem,
        selectedSubsystem,
        showUnchangedModules,
        moduleQuery,
      ).layout,
    [map, selectedSystem, selectedSubsystem, showUnchangedModules, moduleQuery],
  )
  const focusElements = useMemo(
    () =>
      focusSubsystem
        ? architectureFocusElements(map, mode, focusSubsystem, focusDirection)
        : undefined,
    [map, mode, focusSubsystem, focusDirection],
  )
  const focusLayoutInput = useMemo(
    () =>
      focusSubsystem
        ? architectureFocusElements(map, 'overlay', focusSubsystem, focusDirection).layout
        : undefined,
    [map, focusSubsystem, focusDirection],
  )
  const elements = focusElements
    ? { ...focusElements, hiddenUnchangedModules: 0, hiddenModuleCap: 0 }
    : ownershipElements
  const layoutInput = focusLayoutInput ?? ownershipLayoutInput
  const layout = useArchitectureLayout(layoutInput, layoutOptions)
  const nodes = useMemo<readonly Node[]>(
    () =>
      elements.nodes.map((node, index) => {
        const { filename, directory } = moduleLabelParts(node.label)
        const showDirectory = node.kind === 'module' && directory && zoomLabelMode === 'detail'
        return {
          id: node.id,
          position: layout.positions.get(node.id) ?? {
            x: (index % 2) * 288,
            y: Math.floor(index / 2) * 96,
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <>
                <strong>{node.kind === 'module' ? filename : node.label}</strong>
                {showDirectory ? (
                  <span className="architecture-canvas-node-directory">{directory}</span>
                ) : (
                  <span>{node.detail}</span>
                )}
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
            focusSubsystem === node.id ? 'architecture-canvas-node-focused' : '',
          ]
            .filter(Boolean)
            .join(' '),
          draggable: false,
          selectable: true,
          ariaLabel: `${node.kind} ${node.label}, ${node.detail}`,
          domAttributes: { title: node.path ?? node.label },
        }
      }),
    [
      elements.nodes,
      layout.positions,
      selectedSubsystem,
      selectedSystem,
      focusSubsystem,
      zoomLabelMode,
    ],
  )
  const edges = useMemo<readonly Edge[]>(
    () =>
      elements.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'architecture',
        data: { points: layout.edges.get(edge.id)?.points },
        className: `architecture-canvas-edge architecture-canvas-edge-${edge.kind} change-${edge.change}${edge.ghost ? ' ghost' : ''}`,
        markerEnd: edge.kind === 'dependency' ? { type: MarkerType.ArrowClosed } : undefined,
        selectable: Boolean(edge.relationship),
        ariaLabel: edge.relationship
          ? `${edge.relationship.source} to ${edge.relationship.target}, ${edge.change}`
          : `${edge.source} contains ${edge.target}`,
      })),
    [elements.edges, layout.edges],
  )
  const node = map.nodes.find((n) => n.id === (focusSubsystem ?? selectedSubsystem))
  const links = map.relationships.filter((r) => {
    if (focusSubsystem)
      return (
        (focusDirection !== 'imported-by' && r.source === focusSubsystem) ||
        (focusDirection !== 'imports' && r.target === focusSubsystem)
      )
    return (
      !selectedSubsystem ||
      r.source === selectedSubsystem ||
      r.target === selectedSubsystem
    )
  })
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
        {selectedSubsystem && elements.hiddenUnchangedModules ? (
          <button
            type="button"
            className="architecture-map-unchanged-control"
            aria-label={`${showUnchangedModules ? 'Hide' : 'Show'} ${elements.hiddenUnchangedModules} unchanged module${elements.hiddenUnchangedModules === 1 ? '' : 's'} in ${selectedSubsystem}`}
            aria-expanded={showUnchangedModules}
            onClick={() => setShowUnchangedModules(!showUnchangedModules)}
          >
            {showUnchangedModules ? 'Hide' : 'Show'} {elements.hiddenUnchangedModules}{' '}
            unchanged
          </button>
        ) : null}
      </div>
      <p className="architecture-map-note">
        Each top-level node is a system. Select a system to expand its subsystems, then a
        subsystem to expand its modules.
      </p>
      {selectedSubsystem && elements.hiddenModuleCap ? (
        <div className="architecture-map-module-cap" role="group" aria-label="Module cap">
          <p role="status">
            Module limit: {elements.hiddenModuleCap} module
            {elements.hiddenModuleCap === 1 ? '' : 's'} in {selectedSubsystem} not shown.
            Search to reach them.
          </p>
          <label>
            Search modules in canvas
            <input
              value={moduleQuery}
              onChange={(event) => setModuleQuery(event.target.value)}
              placeholder="Filter by filename"
            />
          </label>
        </div>
      ) : null}
      <div className="architecture-map-focus-controls" role="group" aria-label="Focus subsystem">
        <label>
          Focus
          <select
            value={focusSubsystem ?? ''}
            onChange={(event) => setFocusSubsystem(event.target.value || undefined)}
          >
            <option value="">None</option>
            {map.nodes.map((subsystem) => (
              <option key={subsystem.id} value={subsystem.id}>
                {subsystem.id}
              </option>
            ))}
          </select>
        </label>
        {focusSubsystem ? (
          <div role="group" aria-label="Focus direction">
            {(['imports', 'imported-by', 'both'] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                aria-pressed={focusDirection === direction}
                className={focusDirection === direction ? 'active' : ''}
                onClick={() => setFocusDirection(direction)}
              >
                {direction}
              </button>
            ))}
            <button type="button" onClick={() => setFocusSubsystem(undefined)}>
              Clear focus
            </button>
          </div>
        ) : null}
      </div>
      <div
        className="architecture-map-layout-controls"
        role="group"
        aria-label="Layout"
      >
        <div role="group" aria-label="Layout orientation">
          {(['horizontal', 'vertical'] as const).map((orientation) => (
            <button
              key={orientation}
              type="button"
              aria-pressed={layoutOrientation === orientation}
              className={layoutOrientation === orientation ? 'active' : ''}
              onClick={() => setLayoutOrientation(orientation)}
            >
              {orientation}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Layout spacing">
          {(['compact', 'comfortable'] as const).map((spacing) => (
            <button
              key={spacing}
              type="button"
              aria-pressed={layoutSpacing === spacing}
              className={layoutSpacing === spacing ? 'active' : ''}
              onClick={() => setLayoutSpacing(spacing)}
            >
              {spacing}
            </button>
          ))}
        </div>
      </div>
      <ul className="architecture-map-legend" aria-label="Edge legend">
        <li className="architecture-map-legend-dependency">Imports (observed)</li>
        <li className="architecture-map-legend-membership">Contains</li>
      </ul>
      {map.nodes.length === 0 ? (
        <p>
          No source changes in this comparison. Enable All systems to explore the captured
          files.
        </p>
      ) : null}
      <div
        className={`architecture-map-canvas architecture-map-zoom-${zoomLabelMode}`}
        aria-label="Architecture canvas"
      >
        <ReactFlow
          nodes={[...nodes]}
          edges={[...edges]}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          onMove={(_, viewport) => setZoom(viewport.zoom)}
          onNodeClick={(_, clicked) => {
            const canvasNode = elements.nodes.find((item) => item.id === clicked.id)
            if (canvasNode?.path) {
              openEvidence(
                canvasNode.path,
                1,
                mode === 'before' || canvasNode.change === 'removed' ? 'before' : 'after',
              )
            } else if (focusSubsystem && canvasNode?.kind === 'subsystem') {
              setFocusSubsystem(canvasNode.id)
            } else if (canvasNode?.kind === 'system') {
              const next =
                selectedSystem === canvasNode.label ? undefined : canvasNode.label
              setSelectedSystem(next)
              setSelectedSubsystem(undefined)
              setFocusedRelationship(undefined)
              setShowUnchangedModules(false)
              setModuleQuery('')
            } else if (canvasNode?.kind === 'subsystem') {
              setSelectedSubsystem(
                selectedSubsystem === clicked.id ? undefined : clicked.id,
              )
              setFocusedRelationship(undefined)
              setShowUnchangedModules(false)
              setModuleQuery('')
            }
          }}
          onEdgeClick={(_, clicked) => {
            const relationship = elements.edges.find(
              (item) => item.id === clicked.id,
            )?.relationship
            if (relationship) {
              setSelectedSubsystem(relationship.source)
              setFocusedRelationship({
                source: relationship.source,
                target: relationship.target,
              })
            }
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
        focused={focusedRelationship}
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
      <ModuleGroups modules={files} mode={mode} onEvidence={onEvidence} />
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
  const changedModules = modules.filter((module) => module.change !== 'unchanged')
  const unchangedModules = modules.filter((module) => module.change === 'unchanged')
  const visibleChangedModules = changedModules.slice(0, 100)
  const visibleUnchangedModules = unchangedModules.slice(
    0,
    100 - visibleChangedModules.length,
  )
  const groups = [
    {
      key: 'changed',
      title: 'Changed files',
      count: changedModules.length,
      files: visibleChangedModules,
    },
    {
      key: 'unchanged',
      title: 'Unchanged files',
      count: unchangedModules.length,
      files: visibleUnchangedModules,
    },
  ] as const
  return (
    <>
      {groups.map((group) =>
        group.count ? (
          <details
            key={group.key}
            className={`architecture-file-group ${group.key}`}
            aria-label={`${group.title} (${group.count})`}
            open={group.key === 'changed'}
          >
            <summary>
              {group.title} <small>({group.count})</small>
            </summary>
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
          </details>
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
