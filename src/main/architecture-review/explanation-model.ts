import type { HarnessProfileId, HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

export interface ArchitectureExplanationModelRequest {
  readonly projectRoot: HostPath
  readonly workspaceRoot: HostPath
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly prompt: string
  readonly signal: AbortSignal
}

export interface ArchitectureExplanationModelPort {
  generate(
    host: ProjectHost,
    request: ArchitectureExplanationModelRequest,
  ): Promise<string>
}
