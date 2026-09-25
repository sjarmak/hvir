import { useEffect, useState } from 'react'
import { requestArchitectureLayout } from './architecture-layout-client'
import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'
import type { ArchitectureNodePosition } from './architecture-layout'

export function useArchitectureLayout(input: ArchitectureCanvasLayoutInput): {
  readonly positions: ReadonlyMap<string, ArchitectureNodePosition>
  readonly error?: string
} {
  const [state, setState] = useState<{
    readonly positions: ReadonlyMap<string, ArchitectureNodePosition>
    readonly error?: string
  }>({ positions: new Map() })
  useEffect(() => {
    let active = true
    void requestArchitectureLayout(input).then(
      (positions) => {
        if (active)
          setState({
            positions: new Map(positions.map((position) => [position.id, position])),
          })
      },
      (error: unknown) => {
        if (active)
          setState({
            positions: new Map(),
            error: error instanceof Error ? error.message : String(error),
          })
      },
    )
    return () => {
      active = false
    }
  }, [input])
  return state
}
