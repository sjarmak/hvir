import type { ArchitectureAnalysis, ArchitectureModuleDelta } from '../../../shared'

export type ArchitectureMapMode = 'overlay' | 'before' | 'after'

export interface ArchitectureSubsystem {
  readonly id: string
  readonly modules: readonly ArchitectureModuleDelta[]
  readonly changed: number
  readonly nearby: boolean
  readonly x: number
  readonly y: number
}
/** Layout depends on the captured union, never the selected comparison view. */
export function subsystemMap(analysis: ArchitectureAnalysis, all: boolean) {
  const changed = new Set(
    analysis.modules.filter((m) => m.change !== 'unchanged').map((m) => m.group),
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
      ? analysis.modules.map((m) => m.group)
      : [...relevant, ...context.flatMap((r) => [r.source, r.target])],
  )
  for (const r of changedRelations) {
    visible.add(r.source)
    visible.add(r.target)
  }
  const groups = new Map<string, ArchitectureModuleDelta[]>()
  for (const module of analysis.modules)
    groups.set(module.group, [...(groups.get(module.group) ?? []), module])
  const ids = [...visible].sort(
    (a, b) => Number(relevant.has(b)) - Number(relevant.has(a)) || a.localeCompare(b),
  )
  const nodes: ArchitectureSubsystem[] = ids.slice(0, 40).map((id, index) => ({
    id,
    modules: [...(groups.get(id) ?? [])].sort(
      (a, b) =>
        Number(b.change !== 'unchanged') - Number(a.change !== 'unchanged') ||
        a.path.localeCompare(b.path),
    ),
    changed: groups.get(id)?.filter((m) => m.change !== 'unchanged').length ?? 0,
    nearby: !relevant.has(id),
    x: (index % 2) * 290 + 16,
    y: Math.floor(index / 2) * 104 + 16,
  }))
  const shown = new Set(nodes.map((n) => n.id))
  const relationships = analysis.relationships
    .filter((r) => shown.has(r.source) && shown.has(r.target))
    .sort(
      (a, b) =>
        Number(b.change !== 'unchanged') - Number(a.change !== 'unchanged') ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target),
    )
  return {
    nodes,
    relationships: relationships.slice(0, 120),
    omittedNodes: Math.max(0, ids.length - nodes.length),
    omittedRelationships: Math.max(0, relationships.length - 120),
  }
}
