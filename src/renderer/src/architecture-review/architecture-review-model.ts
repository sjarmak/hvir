import {
  ARCHITECTURE_LAYOUT_FILE,
  type ArchitectureAnalysis,
  type ArchitectureImportDelta,
  type ArchitectureLayout,
  type ArchitectureModuleDelta,
  type ArchitectureRelationshipDelta,
} from '../../../shared'

export type ArchitectureMapMode = 'overlay' | 'before' | 'after'

export interface ArchitectureSubsystem {
  readonly id: string
  readonly modules: readonly ArchitectureModuleDelta[]
  readonly changed: number
  readonly nearby: boolean
  readonly change: ArchitectureModuleDelta['change']
}
export function subsystemMap(analysis: ArchitectureAnalysis, all: boolean) {
  const changed = new Set(
    analysis.modules.filter((m) => m.change !== 'unchanged').map((m) => m.subsystem),
  )
  const changedRelations = analysis.relationships.filter((r) => r.change !== 'unchanged')
  const relevant = new Set([
    ...changed,
    ...changedRelations.flatMap((r) => [r.source, r.target]),
  ])
  const context = analysis.relationships
    .filter((r) => relevant.has(r.source) || relevant.has(r.target))
    .filter(
      (r) => !r.target.startsWith('external:') && !r.target.startsWith('unresolved:'),
    )
  const visible = new Set(
    all
      ? analysis.modules.map((m) => m.subsystem)
      : [...relevant, ...context.flatMap((r) => [r.source, r.target])],
  )
  for (const r of changedRelations) {
    visible.add(r.source)
    visible.add(r.target)
  }
  const members = new Map<string, ArchitectureModuleDelta[]>()
  for (const module of analysis.modules)
    members.set(module.subsystem, [...(members.get(module.subsystem) ?? []), module])
  const ids = [...visible].sort(
    (a, b) => Number(relevant.has(b)) - Number(relevant.has(a)) || a.localeCompare(b),
  )
  const nodes: ArchitectureSubsystem[] = ids.slice(0, 40).map((id) => {
    const modules = [...(members.get(id) ?? [])].sort(
      (a, b) =>
        Number(b.change !== 'unchanged') - Number(a.change !== 'unchanged') ||
        a.path.localeCompare(b.path),
    )
    return {
      id,
      modules,
      changed: modules.filter((module) => module.change !== 'unchanged').length,
      nearby: !relevant.has(id),
      change: combinedChange(modules.map((module) => module.change)),
    }
  })
  const shown = new Set(nodes.map((n) => n.id))
  const relationships = analysis.relationships
    .filter((r) => shown.has(r.source) && shown.has(r.target))
    .sort(
      (a, b) =>
        Number(b.change !== 'unchanged') - Number(a.change !== 'unchanged') ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target),
    )
  const layoutIds = [
    ...new Set([
      ...analysis.modules.map((module) => module.subsystem),
      ...analysis.relationships.flatMap((relationship) => [
        relationship.source,
        relationship.target,
      ]),
    ]),
  ].sort((left, right) => left.localeCompare(right))
  const layoutRelationships = [...analysis.relationships].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  )
  const layoutModules = [...analysis.modules].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  return {
    nodes,
    relationships: relationships.slice(0, 120),
    layoutIds,
    layoutRelationships,
    layoutModules,
    omittedNodes: Math.max(0, ids.length - nodes.length),
    omittedRelationships: Math.max(0, relationships.length - 120),
  }
}

export interface ArchitectureCanvasNode {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly kind: 'subsystem' | 'module'
  readonly change: ArchitectureModuleDelta['change']
  readonly ghost: boolean
  readonly nearby: boolean
  readonly path?: string
}

export interface ArchitectureCanvasEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly change: ArchitectureModuleDelta['change']
  readonly ghost: boolean
  readonly relationship?: ArchitectureRelationshipDelta
}

export interface ArchitectureCanvasLayoutInput {
  readonly nodes: readonly {
    readonly id: string
    readonly width: number
    readonly height: number
  }[]
  readonly edges: readonly {
    readonly id: string
    readonly source: string
    readonly target: string
  }[]
}

export function architectureCanvasElements(
  map: ReturnType<typeof subsystemMap>,
  mode: ArchitectureMapMode,
  expandedSubsystem?: string,
): {
  readonly nodes: readonly ArchitectureCanvasNode[]
  readonly edges: readonly ArchitectureCanvasEdge[]
  readonly layout: ArchitectureCanvasLayoutInput
} {
  const subsystemNodes = map.nodes.map((node) => ({
    id: node.id,
    label: node.id,
    detail: node.modules.length
      ? `${node.changed} changed · ${node.modules.length} files`
      : 'External or unresolved import',
    kind: 'subsystem' as const,
    change: node.change,
    ghost: absentInMode(node.change, mode),
    nearby: node.nearby,
  }))
  const expanded = map.nodes.find((node) => node.id === expandedSubsystem)
  const moduleNodes = (expanded?.modules ?? []).slice(0, 200).map((module) => ({
    id: `module:${module.path}`,
    label: module.path,
    detail: moduleChangeLabel(module.change),
    kind: 'module' as const,
    change: module.change,
    ghost: absentInMode(module.change, mode),
    nearby: false,
    path: module.path,
  }))
  const relationshipEdges = map.relationships.map((relationship) => ({
    id: `relationship:${relationship.source}:${relationship.target}`,
    source: relationship.source,
    target: relationship.target,
    change: relationship.change,
    ghost: absentInMode(relationship.change, mode),
    relationship,
  }))
  const membershipEdges = moduleNodes.map((node) => ({
    id: `membership:${expandedSubsystem}:${node.id}`,
    source: expandedSubsystem!,
    target: node.id,
    change: node.change,
    ghost: node.ghost,
  }))
  const layoutModuleNodes = map.layoutModules
    .filter((module) => module.subsystem === expandedSubsystem)
    .slice(0, 200)
    .map((module) => ({ id: `module:${module.path}`, width: 220, height: 52 }))
  const layoutMembershipEdges = layoutModuleNodes.map((node) => ({
    id: `membership:${expandedSubsystem}:${node.id}`,
    source: expandedSubsystem!,
    target: node.id,
  }))
  const nodes = [...subsystemNodes, ...moduleNodes]
  const edges = [...relationshipEdges, ...membershipEdges]
  return {
    nodes,
    edges,
    layout: {
      nodes: [
        ...map.layoutIds.map((id) => ({ id, width: 244, height: 64 })),
        ...layoutModuleNodes,
      ],
      edges: [
        ...map.layoutRelationships.map(({ source, target }) => ({
          id: `relationship:${source}:${target}`,
          source,
          target,
        })),
        ...layoutMembershipEdges,
      ],
    },
  }
}

function combinedChange(
  changes: readonly ArchitectureModuleDelta['change'][],
): ArchitectureModuleDelta['change'] {
  if (changes.length === 0 || changes.every((change) => change === 'unchanged'))
    return 'unchanged'
  if (changes.every((change) => change === 'added')) return 'added'
  if (changes.every((change) => change === 'removed')) return 'removed'
  return 'changed'
}

function absentInMode(
  change: ArchitectureModuleDelta['change'],
  mode: ArchitectureMapMode,
): boolean {
  return (
    (mode === 'before' && change === 'added') ||
    (mode === 'after' && change === 'removed')
  )
}

function moduleChangeLabel(change: ArchitectureModuleDelta['change']): string {
  return change[0]!.toUpperCase() + change.slice(1)
}

export interface ArchitectureModuleEvidence {
  readonly module: string
  readonly imports: readonly ArchitectureImportDelta[]
}

/** A relationship's evidence as modules in path order, each with its imports in order. */
export function evidenceByModule(
  evidence: readonly ArchitectureImportDelta[],
  limit: number,
): { readonly modules: readonly ArchitectureModuleEvidence[]; readonly omitted: number } {
  const shown = evidence.slice(0, limit)
  const byModule = new Map<string, ArchitectureImportDelta[]>()
  for (const fact of shown)
    byModule.set(fact.source, [...(byModule.get(fact.source) ?? []), fact])
  return {
    modules: [...byModule]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([module, imports]) => ({ module, imports })),
    omitted: evidence.length - shown.length,
  }
}

/** Where a snapshot's subsystems and scope came from, in words for its details. */
export function layoutSummary(layout: ArchitectureLayout): {
  readonly subsystems: string
  readonly scope: string
} {
  const roots = layout.sourceRoots.join(', ')
  const rules = layout.subsystems.length
  return {
    subsystems:
      layout.origin === 'override'
        ? `${ARCHITECTURE_LAYOUT_FILE}: ${rules} rule${rules === 1 ? '' : 's'}, then the first directory under ${roots}`
        : `First directory under ${roots} (no ${ARCHITECTURE_LAYOUT_FILE})`,
    scope: layout.scope.length ? layout.scope.join(', ') : 'Whole repository',
  }
}
