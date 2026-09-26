import type { ElkNode } from 'elkjs/lib/elk-api'

export interface ArchitectureLayoutRegistration {
  readonly cmd: 'register'
  readonly id: 0
  readonly algorithms: readonly ['layered']
}

export interface ArchitectureLayoutRequest {
  readonly cmd: 'layout'
  readonly id: number
  readonly graph: ElkNode
  readonly layoutOptions: Record<string, never>
  readonly options: Record<string, never>
}

export interface ArchitectureLayoutResponse {
  readonly id: number
  readonly data?: ElkNode
  readonly error?: unknown
}
