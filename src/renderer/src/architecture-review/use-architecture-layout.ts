import { useEffect, useState } from 'react'
import { requestArchitectureLayout } from './architecture-layout-client'
import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'
import type {
  ArchitectureEdgeRoute,
  ArchitectureLayoutOptions,
  ArchitectureNodePosition,
} from './architecture-layout'

export function useArchitectureLayout(
  input: ArchitectureCanvasLayoutInput,
  options: ArchitectureLayoutOptions = {},
): {
  readonly positions: ReadonlyMap<string, ArchitectureNodePosition>
  readonly edges: ReadonlyMap<string, ArchitectureEdgeRoute>
  readonly error?: string
} {
  const [state, setState] = useState<{
    readonly positions: ReadonlyMap<string, ArchitectureNodePosition>
    readonly edges: ReadonlyMap<string, ArchitectureEdgeRoute>
    readonly error?: string
  }>({ positions: new Map(), edges: new Map() })
  useEffect(() => {
    let active = true
    void requestArchitectureLayout(input, options).then(
      ({ positions, edges }) => {
        if (active)
          setState({
            positions: new Map(positions.map((position) => [position.id, position])),
            edges: new Map(edges.map((edge) => [edge.id, edge])),
          })
      },
      (error: unknown) => {
        if (active)
          setState({
            positions: new Map(),
            edges: new Map(),
            error: error instanceof Error ? error.message : String(error),
          })
      },
    )
    return () => {
      active = false
    }
  }, [input, options])
  return state
}
