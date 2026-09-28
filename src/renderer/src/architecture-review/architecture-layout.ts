import type { ElkNode } from 'elkjs/lib/elk-api'
import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'

export interface ArchitectureNodePosition {
  readonly id: string
  readonly x: number
  readonly y: number
}

export function architectureLayoutGraph(
  input: ArchitectureCanvasLayoutInput,
): ElkNode {
  return {
    id: 'architecture',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '44',
      'elk.layered.spacing.nodeNodeBetweenLayers': '88',
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
