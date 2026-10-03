import type { HostPath } from '../shared'
import { BeadsService } from './beads/beads-service'
import { ownGasCityService } from './gascity/gascity-owner'
import type { GasCityReader } from './gascity/gascity-reader'
import { GitHubService } from './github/github-service'
import type { EmitRendererEvent, IpcDeps } from './ipc/deps'
import { NeedsYouService } from './needs-you/needs-you-service'
import type { ProjectHost, ProjectHostCatalog } from './project-host'
import type { ProjectRegistry } from './project-registry'

export function ownRailServices(
  getProject: () => { readonly host: ProjectHost; readonly root: HostPath },
  cityReader: GasCityReader,
  registry: Pick<ProjectRegistry, 'state' | 'observe'>,
  hostCatalog: Pick<ProjectHostCatalog, 'connectedHosts'> | undefined,
  emit: EmitRendererEvent,
): Pick<IpcDeps, 'beads' | 'gascity' | 'github' | 'needsYou'> {
  const beads = new BeadsService({ getProject })
  const github = new GitHubService({ getProject })
  return {
    beads,
    gascity: ownGasCityService(getProject, cityReader),
    github,
    needsYou: new NeedsYouService({
      getProjectState: () => registry.state(),
      connectedHosts: () => hostCatalog?.connectedHosts() ?? [],
      observeCandidates: (listener) => registry.observe(listener),
      onCandidatesChanged: (candidateRevision) =>
        emit('needs-you:changed', { candidateRevision }),
      beads,
      github,
      cityRigs: async (target) =>
        (await cityReader.inCity(target)) ? cityReader.rigs(target) : undefined,
    }),
  }
}
