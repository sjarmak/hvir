import type { HostPath } from '../shared'
import { BeadsService } from './beads/beads-service'
import { ownGasCityService } from './gascity/gascity-owner'
import type { GasCityReader } from './gascity/gascity-reader'
import { GitHubService } from './github/github-service'
import type { IpcDeps } from './ipc/deps'
import type { ProjectHost } from './project-host'

export function ownRailServices(
  getProject: () => { readonly host: ProjectHost; readonly root: HostPath },
  cityReader: GasCityReader,
): Pick<IpcDeps, 'beads' | 'gascity' | 'github'> {
  return {
    beads: new BeadsService({ getProject }),
    gascity: ownGasCityService(getProject, cityReader),
    github: new GitHubService({ getProject }),
  }
}
