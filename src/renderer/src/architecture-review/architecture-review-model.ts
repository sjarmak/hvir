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
  const layoutRelationships = [...analysis.relationships].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  )
  const layoutModules = [...analysis.modules].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const changedModules = new Set(
    layoutModules
      .filter((module) => module.change !== 'unchanged')
      .map((module) => module.path),
  )
  const moduleSubsystem = new Map(
    layoutModules.map((module) => [module.path, module.subsystem]),
  )
  const changedRelationshipPairs = new Set(
    changedRelations.map((r) => `${r.source}::${r.target}`),
  )
  const relatedModules = new Set<string>()
  for (const entry of analysis.imports) {
    if (!entry.target) continue
    if (!changedModules.has(entry.source) && !changedModules.has(entry.target)) continue
    const sourceSubsystem = moduleSubsystem.get(entry.source)
    const targetSubsystem = moduleSubsystem.get(entry.target)
    const sameSubsystem =
      sourceSubsystem !== undefined && sourceSubsystem === targetSubsystem
    if (
      !sameSubsystem &&
      !changedRelationshipPairs.has(`${sourceSubsystem}::${targetSubsystem}`)
    )
      continue
    relatedModules.add(entry.source)
    relatedModules.add(entry.target)
  }
  return {
    nodes,
    relationships: relationships.slice(0, 120),
    layoutRelationships,
    layoutModules,
    relatedModules: [...relatedModules].sort(),
    omittedNodes: Math.max(0, ids.length - nodes.length),
    omittedRelationships: Math.max(0, relationships.length - 120),
  }
}

export interface ArchitectureCanvasNode {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly kind: 'system' | 'subsystem' | 'module'
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
  readonly kind: 'dependency' | 'membership'
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
  expandedSystem?: string,
  expandedSubsystem?: string,
  showUnchangedModules = false,
): {
  readonly nodes: readonly ArchitectureCanvasNode[]
  readonly edges: readonly ArchitectureCanvasEdge[]
  readonly layout: ArchitectureCanvasLayoutInput
  readonly hiddenUnchangedModules: number
} {
  const systems = systemGroups(map.nodes)
  const systemNodes = systems.map((system) => ({
    id: `system:${system.name}`,
    label: system.name,
    detail: `${system.subsystems.length} subsystem${system.subsystems.length === 1 ? '' : 's'} · ${system.changed} changed`,
    kind: 'system' as const,
    change: combinedChange(system.subsystems.map((node) => node.change)),
    ghost: system.subsystems.every((node) => absentInMode(node.change, mode)),
    nearby: system.subsystems.every((node) => node.nearby),
  }))
  const visibleSystems = new Set(systems.map((system) => system.name))
  const systemRelationships = aggregateSystemRelationships(
    map.relationships,
    map.layoutModules,
  ).filter(
    (relationship) =>
      visibleSystems.has(relationship.source) && visibleSystems.has(relationship.target),
  )
  const systemRelationshipEdges = systemRelationships.map((relationship) => ({
    id: `system-relationship:${relationship.source}:${relationship.target}`,
    source: `system:${relationship.source}`,
    target: `system:${relationship.target}`,
    change: relationship.change,
    ghost: absentInMode(relationship.change, mode),
    kind: 'dependency' as const,
  }))
  const systemSubsystems =
    systems.find((system) => system.name === expandedSystem)?.subsystems ?? []
  const subsystemNodes = systemSubsystems.map((node) => ({
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
  const expanded = systemSubsystems.find((node) => node.id === expandedSubsystem)
  const relatedModules = new Set(map.relatedModules)
  const hiddenUnchangedModules = (expanded?.modules ?? []).filter(
    (module) => module.change === 'unchanged' && !relatedModules.has(module.path),
  ).length
  const visibleModules = (expanded?.modules ?? []).filter(
    (module) =>
      showUnchangedModules ||
      module.change !== 'unchanged' ||
      relatedModules.has(module.path),
  )
  const moduleNodes = visibleModules.slice(0, 200).map((module) => ({
    id: `module:${module.path}`,
    label: module.path,
    detail: moduleChangeLabel(module.change),
    kind: 'module' as const,
    change: module.change,
    ghost: absentInMode(module.change, mode),
    nearby: false,
    path: module.path,
  }))
  const visibleSubsystems = new Set(subsystemNodes.map((node) => node.id))
  const relationshipEdges = map.relationships
    .filter(
      (relationship) =>
        visibleSubsystems.has(relationship.source) &&
        visibleSubsystems.has(relationship.target),
    )
    .map((relationship) => ({
      id: `relationship:${relationship.source}:${relationship.target}`,
      source: relationship.source,
      target: relationship.target,
      change: relationship.change,
      ghost: absentInMode(relationship.change, mode),
      kind: 'dependency' as const,
      relationship,
    }))
  const systemMembershipEdges = subsystemNodes.map((node) => ({
    id: `system-membership:${expandedSystem}:${node.id}`,
    source: `system:${expandedSystem}`,
    target: node.id,
    change: node.change,
    ghost: node.ghost,
    kind: 'membership' as const,
  }))
  const membershipEdges = moduleNodes.map((node) => ({
    id: `membership:${expandedSubsystem}:${node.id}`,
    source: expandedSubsystem!,
    target: node.id,
    change: node.change,
    ghost: node.ghost,
    kind: 'membership' as const,
  }))
  const layoutSubsystems = [
    ...new Set(
      map.layoutModules
        .filter((module) => module.system === expandedSystem)
        .map((module) => module.subsystem),
    ),
  ].sort()
  const layoutModuleNodes = (
    expanded
      ? visibleModules
      : map.layoutModules.filter(
          (module) =>
            module.system === expandedSystem && module.subsystem === expandedSubsystem,
        )
  )
    .slice(0, 200)
    .map((module) => ({ id: `module:${module.path}`, width: 220, height: 52 }))
  const layoutMembershipEdges = layoutModuleNodes.map((node) => ({
    id: `membership:${expandedSubsystem}:${node.id}`,
    source: expandedSubsystem!,
    target: node.id,
  }))
  const layoutSystems = [
    ...new Set(map.layoutModules.map((module) => module.system)),
  ].sort()
  const nodes = [...systemNodes, ...subsystemNodes, ...moduleNodes]
  const edges = [
    ...systemRelationshipEdges,
    ...systemMembershipEdges,
    ...relationshipEdges,
    ...membershipEdges,
  ]
  return {
    nodes,
    edges,
    hiddenUnchangedModules,
    layout: {
      nodes: [
        ...layoutSystems.map((id) => ({ id: `system:${id}`, width: 244, height: 64 })),
        ...layoutSubsystems.map((id) => ({ id, width: 244, height: 64 })),
        ...layoutModuleNodes,
      ],
      edges: [
        ...aggregateSystemRelationships(map.layoutRelationships, map.layoutModules).map(
          ({ source, target }) => ({
            id: `system-relationship:${source}:${target}`,
            source: `system:${source}`,
            target: `system:${target}`,
          }),
        ),
        ...layoutSubsystems.map((id) => ({
          id: `system-membership:${expandedSystem}:${id}`,
          source: `system:${expandedSystem}`,
          target: id,
        })),
        ...map.layoutRelationships
          .filter(
            ({ source, target }) =>
              layoutSubsystems.includes(source) && layoutSubsystems.includes(target),
          )
          .map(({ source, target }) => ({
            id: `relationship:${source}:${target}`,
            source,
            target,
          })),
        ...layoutMembershipEdges,
      ],
    },
  }
}

export type ArchitectureFocusDirection = 'imports' | 'imported-by' | 'both'

/** A subsystem plus its direct dependency neighbors, regardless of system membership. */
export function architectureFocusElements(
  map: ReturnType<typeof subsystemMap>,
  mode: ArchitectureMapMode,
  subsystem: string,
  direction: ArchitectureFocusDirection,
): {
  readonly nodes: readonly ArchitectureCanvasNode[]
  readonly edges: readonly ArchitectureCanvasEdge[]
  readonly layout: ArchitectureCanvasLayoutInput
} {
  const byId = new Map(map.nodes.map((node) => [node.id, node]))
  const relationships = map.relationships.filter(
    (relationship) =>
      (direction !== 'imported-by' && relationship.source === subsystem) ||
      (direction !== 'imports' && relationship.target === subsystem),
  )
  const neighborIds = new Set(
    relationships.flatMap((relationship) => [relationship.source, relationship.target]),
  )
  neighborIds.add(subsystem)
  const nodes = [...neighborIds]
    .map((id) => byId.get(id))
    .filter((node): node is ArchitectureSubsystem => node !== undefined)
    .map((node) => ({
      id: node.id,
      label: node.id,
      detail: node.modules.length
        ? `${node.changed} changed · ${node.modules.length} files`
        : 'External or unresolved import',
      kind: 'subsystem' as const,
      change: node.change,
      ghost: absentInMode(node.change, mode),
      nearby: node.id !== subsystem,
    }))
  const edges = relationships.map((relationship) => ({
    id: `focus-relationship:${relationship.source}:${relationship.target}`,
    source: relationship.source,
    target: relationship.target,
    change: relationship.change,
    ghost: absentInMode(relationship.change, mode),
    kind: 'dependency' as const,
    relationship,
  }))
  return {
    nodes,
    edges,
    layout: {
      nodes: nodes.map((node) => ({ id: node.id, width: 244, height: 64 })),
      edges: edges.map(({ id, source, target }) => ({ id, source, target })),
    },
  }
}

function aggregateSystemRelationships(
  relationships: readonly ArchitectureRelationshipDelta[],
  modules: readonly ArchitectureModuleDelta[],
) {
  const systems = new Map<string, string>()
  for (const module of modules)
    if (!systems.has(module.subsystem)) systems.set(module.subsystem, module.system)
  const grouped = new Map<string, ArchitectureRelationshipDelta['change'][]>()
  for (const relationship of relationships) {
    const source = systems.get(relationship.source)
    const target = systems.get(relationship.target)
    if (!source || !target || source === target) continue
    const key = JSON.stringify([source, target])
    grouped.set(key, [...(grouped.get(key) ?? []), relationship.change])
  }
  return [...grouped]
    .map(([key, changes]) => {
      const [source, target] = JSON.parse(key) as [string, string]
      return { source, target, change: combinedChange(changes) }
    })
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target),
    )
}

function systemGroups(nodes: readonly ArchitectureSubsystem[]) {
  const systems = new Map<string, ArchitectureSubsystem[]>()
  for (const node of nodes) {
    for (const system of new Set(node.modules.map((module) => module.system))) {
      const modules = node.modules.filter((module) => module.system === system)
      systems.set(system, [
        ...(systems.get(system) ?? []),
        {
          ...node,
          modules,
          changed: modules.filter((module) => module.change !== 'unchanged').length,
          change: combinedChange(modules.map((module) => module.change)),
        },
      ])
    }
  }
  return [...systems]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, subsystems]) => ({
      name,
      subsystems,
      changed: subsystems.reduce((total, subsystem) => total + subsystem.changed, 0),
    }))
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
  readonly systems: string
  readonly subsystems: string
  readonly scope: string
} {
  const roots = layout.sourceRoots.join(', ')
  const rules = layout.subsystems.length
  return {
    systems: layout.systems.length
      ? `${ARCHITECTURE_LAYOUT_FILE}: ${layout.systems.map((system) => system.name).join(', ')}`
      : 'Inferred from project layout',
    subsystems:
      layout.origin === 'override'
        ? `${ARCHITECTURE_LAYOUT_FILE}: ${rules} rule${rules === 1 ? '' : 's'}, then the first directory under ${roots}`
        : `First directory under ${roots} (no ${ARCHITECTURE_LAYOUT_FILE})`,
    scope: layout.scope.length ? layout.scope.join(', ') : 'Whole repository',
  }
}
