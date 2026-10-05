import { createElectronSshConfiguration } from '../project-host/electron-ssh-configuration'
import type { ProjectHostCatalog } from '../project-host/project-host-catalog'
import type { GitMutationCoordinator } from '../git/mutation-coordinator'
import type { ProjectCoordinator } from '../project-coordinator'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { WorkspaceCoordinator } from '../workspace-coordinator'
import type { IpcDeps } from './deps'
import type { RendererSshPrompter } from '../project-host/renderer-ssh-prompter'

type ProjectCommandDeps = Pick<
  IpcDeps,
  | 'sshConfiguration'
  | 'listHosts'
  | 'connectHost'
  | 'disconnectHost'
  | 'browseHost'
  | 'openProject'
  | 'switchWorkspace'
  | 'refreshProject'
  | 'updateWatchInterests'
  | 'closeProject'
  | 'pruneWorktrees'
  | 'dismissWorkspace'
  | 'unfinishedHandoffs'
  | 'removeUnfinishedHandoff'
  | 'planWorkspaceClose'
  | 'closeWorkspace'
  | 'reopenWorkspace'
  | 'acknowledgeWorkspace'
  | 'switchGitBranch'
  | 'fetchGit'
  | 'pullGit'
  | 'createPullWorktree'
>

export function createProjectCommands({
  hosts,
  projects,
  workspaces,
  git,
  withSshPresentation,
}: {
  readonly hosts: Pick<ProjectHostCatalog, 'listHosts' | 'refreshHosts' | 'addSshHost'>
  readonly projects: ProjectCoordinator
  readonly workspaces: WorkspaceCoordinator
  readonly git: GitMutationCoordinator
  readonly withSshPresentation: <T>(owner: RendererOwner, operation: () => T) => T
}): ProjectCommandDeps {
  return {
    sshConfiguration: createElectronSshConfiguration(hosts),
    listHosts: () => hosts.listHosts(),
    connectHost: (hostId, owner) =>
      withSshPresentation(owner, () => projects.connectHost(hostId)),
    disconnectHost: (hostId) => projects.disconnectHost(hostId),
    browseHost: (hostId, path, owner) =>
      withSshPresentation(owner, () => projects.browseHost(hostId, path)),
    openProject: (hostId, path, owner) =>
      withSshPresentation(owner, () => projects.openProject(hostId, path)),
    switchWorkspace: (projectId, workspaceId) =>
      projects.switchWorkspace(projectId, workspaceId),
    refreshProject: (projectId) => workspaces.refresh(projectId),
    updateWatchInterests: (paths) => workspaces.updateWatchInterests(paths),
    closeProject: (projectId) => projects.closeProject(projectId),
    pruneWorktrees: (projectId) => git.pruneWorktrees(projectId),
    dismissWorkspace: (projectId, workspaceId) =>
      projects.dismissWorkspace(projectId, workspaceId),
    unfinishedHandoffs: (projectId) => git.unfinishedHandoffs(projectId),
    removeUnfinishedHandoff: (projectId, workspaceId) =>
      git.removeUnfinishedHandoff(projectId, workspaceId),
    planWorkspaceClose: (projectId, workspaceId) =>
      Promise.resolve(projects.planWorkspaceClose(projectId, workspaceId)),
    closeWorkspace: (projectId, workspaceId, expectedTerminalCount, terminateTerminals) =>
      projects.closeWorkspace(
        projectId,
        workspaceId,
        expectedTerminalCount,
        terminateTerminals,
      ),
    reopenWorkspace: (projectId, workspaceId) =>
      projects.reopenWorkspace(projectId, workspaceId),
    acknowledgeWorkspace: (projectId, workspaceId) =>
      projects.acknowledgeWorkspace(projectId, workspaceId),
    switchGitBranch: (root, branch) => git.switchBranch(root, branch),
    fetchGit: (root) => git.fetch(root),
    pullGit: (root) => git.pull(root),
    createPullWorktree: (root, source) => git.addPullWorktree(root, source),
  }
}

export function createApplicationProjectCommands(
  hosts: Pick<ProjectHostCatalog, 'listHosts' | 'refreshHosts' | 'addSshHost'>,
  projects: ProjectCoordinator,
  workspaces: WorkspaceCoordinator,
  git: GitMutationCoordinator,
  sshPrompter: RendererSshPrompter,
): ProjectCommandDeps {
  return createProjectCommands({
    hosts,
    projects,
    workspaces,
    git,
    withSshPresentation: (owner, operation) => sshPrompter.runForOwner(owner, operation),
  })
}
