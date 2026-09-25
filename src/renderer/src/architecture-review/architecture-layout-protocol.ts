import type { ArchitectureCanvasLayoutInput } from './architecture-review-model'
import type { ArchitectureNodePosition } from './architecture-layout'

export interface ArchitectureLayoutRequest {
  readonly id: number
  readonly input: ArchitectureCanvasLayoutInput
}

export type ArchitectureLayoutResponse =
  | {
      readonly id: number
      readonly type: 'layout'
      readonly positions: readonly ArchitectureNodePosition[]
    }
  | {
      readonly id: number
      readonly type: 'error'
      readonly message: string
    }
