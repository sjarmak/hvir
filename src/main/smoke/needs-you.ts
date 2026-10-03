import type { EmitRendererEvent } from '../ipc/deps'
import type { BeadsService } from '../beads/beads-service'
import type { GitHubService } from '../github/github-service'
import { NeedsYouService } from '../needs-you/needs-you-service'
import type { ProjectHost } from '../project-host'
import type { createSmokeProjectState } from './project-state-fixture'

export function createSmokeNeedsYou(options: {
  readonly host: ProjectHost
  readonly projectFixture: ReturnType<typeof createSmokeProjectState>
  readonly beads: BeadsService
  readonly github: GitHubService
  readonly emit: EmitRendererEvent
}): NeedsYouService {
  return new NeedsYouService({
    getProjectState: () => options.projectFixture.get(),
    connectedHosts: () => [options.host],
    beads: options.beads,
    github: options.github,
    onCandidatesChanged: (candidateRevision) =>
      options.emit('needs-you:changed', { candidateRevision }),
  })
}
