import type { ElkNode } from 'elkjs/lib/elk-api'
import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'

export interface ArchitectureNodePosition {
  readonly id: string
  readonly x: number
  readonly y: number
}

export type ArchitectureLayoutOrientation = 'horizontal' | 'vertical'
export type ArchitectureLayoutSpacing = 'compact' | 'comfortable'

export interface ArchitectureLayoutOptions {
  readonly orientation?: ArchitectureLayoutOrientation
  readonly spacing?: ArchitectureLayoutSpacing
}

const ARCHITECTURE_LAYOUT_SPACING = {
  compact: { nodeNode: 28, betweenLayers: 56 },
  comfortable: { nodeNode: 44, betweenLayers: 88 },
} as const satisfies Record<ArchitectureLayoutSpacing, { nodeNode: number; betweenLayers: number }>

export function architectureLayoutGraph(
  input: ArchitectureCanvasLayoutInput,
  options: ArchitectureLayoutOptions = {},
): ElkNode {
  const spacing = ARCHITECTURE_LAYOUT_SPACING[options.spacing ?? 'comfortable']
  return {
    id: 'architecture',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': options.orientation === 'vertical' ? 'DOWN' : 'RIGHT',
      'elk.spacing.nodeNode': String(spacing.nodeNode),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.betweenLayers),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: input.nodes.map((node) => ({ ...node })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  }
}

export function architectureNodePositions(
  result: ElkNode,
): readonly ArchitectureNodePosition[] {
  return (result.children ?? [])
    .map((node) => ({
      id: node.id,
      x: Math.round(node.x ?? 0),
      y: Math.round(node.y ?? 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export interface ArchitectureEdgeRoute {
  readonly id: string
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

export function architectureEdgeRoutes(result: ElkNode): readonly ArchitectureEdgeRoute[] {
  return (result.edges ?? [])
    .map((edge) => {
      const section = edge.sections?.[0]
      if (!section) return undefined
      return {
        id: edge.id,
        points: [
          section.startPoint,
          ...(section.bendPoints ?? []),
          section.endPoint,
        ].map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
      }
    })
    .filter((route): route is ArchitectureEdgeRoute => route !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
}
