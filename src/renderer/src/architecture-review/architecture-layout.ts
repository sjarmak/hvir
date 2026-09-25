import ELK from 'elkjs/lib/elk.bundled.js'
import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'

const elk = new ELK()

export interface ArchitectureNodePosition {
  readonly id: string
  readonly x: number
  readonly y: number
}

export async function layoutArchitectureGraph(
  input: ArchitectureCanvasLayoutInput,
): Promise<readonly ArchitectureNodePosition[]> {
  const result = await elk.layout({
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
  })
  return (result.children ?? [])
    .map((node) => ({
      id: node.id,
      x: Math.round(node.x ?? 0),
      y: Math.round(node.y ?? 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}
