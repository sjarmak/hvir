import {
  hostPathEquals,
  type HostPath,
  type ProjectState,
  type RegisteredProjectState,
  type WorktreeDiscovery,
} from '../../shared'
import {
  hvirWorktreeSlug,
  hvirWorktreeTarget,
  type HvirWorktreeTarget,
} from './hvir-worktrees'
import type { GitMutationGrant, GitMutationGrantRequest } from './mutation-authorization'
import { inspectUnfinishedHandoff } from '../architecture-review/unfinished-handoff'
import type { ProjectHost } from '../project-host'
import type { ProjectWatchTarget } from '../project-watch'
import type {
  WorkspaceRemovalPort,
  WorkspaceTerminalPort,
} from '../workspace-removal-coordinator'

export interface GitMutationRegistryPort {
  readonly active: ProjectWatchTarget & {
    readonly workspaceId: string
  }
  state(): ProjectState
  projectById(projectId: string): RegisteredProjectState | undefined
  authorityForPath(
    hostId: string,
    path: string,
  ): { readonly host: ProjectHost } | undefined
  reconcileWorktrees(
    projectId: string,
    discovery: WorktreeDiscovery,
  ): Promise<ProjectState>
}

export interface GitMutationWorkerPort {
  discover(root: HostPath): Promise<WorktreeDiscovery>
  pruneWorktrees(root: HostPath): Promise<WorktreeDiscovery>
  addWorktree(root: HostPath, target: HvirWorktreeTarget): Promise<WorktreeDiscovery>
  removeWorktree(root: HostPath, target: HvirWorktreeTarget): Promise<WorktreeDiscovery>
  deleteHvirBranch(root: HostPath, target: HvirWorktreeTarget): Promise<WorktreeDiscovery>
  switchBranch(
    root: HostPath,
    branch: string,
    relatedWorktreeRoots: readonly HostPath[],
  ): Promise<void>
  fetch(root: HostPath): Promise<void>
  pull(root: HostPath, relatedWorktreeRoots: readonly HostPath[]): Promise<void>
}

export interface GitMutationWorkspacePort {
  serialize<T>(operation: () => Promise<T>): Promise<T>
  refresh(projectId: string): Promise<ProjectState>
  scheduleRefresh(projectId: string): void
  coalesceProjectOperation(
    projectId: string,
    operation: () => Promise<ProjectState>,
  ): Promise<ProjectState>
  invalidateProject(projectId: string): void
  settleProject(projectId: string): Promise<void>
  stopWatch(): Promise<void>
  replaceWatch(target?: ProjectWatchTarget): Promise<void>
}

export interface GitMutationCoordinatorOptions {
  readonly registry: GitMutationRegistryPort
  readonly worker: GitMutationWorkerPort
  readonly workspaces: GitMutationWorkspacePort
  readonly authorizations: {
    grant(request: GitMutationGrantRequest): GitMutationGrant
  }
  readonly removal: WorkspaceRemovalPort & WorkspaceTerminalPort
  readonly onError?: (message: string, error: unknown) => void
}

/** The workspace a review handoff created, registered and ready to switch to. */
export interface AddedWorktree {
  readonly projectId: string
  readonly workspaceId: string
  readonly root: HostPath
  readonly branch: string
}

/** Coordinates the complete lifecycle of the bounded Git mutations exposed by hvir. */
export class GitMutationCoordinator {
  constructor(private readonly options: GitMutationCoordinatorOptions) {}

  pruneWorktrees(projectId: string): Promise<ProjectState> {
    const { workspaces } = this.options
    workspaces.invalidateProject(projectId)
    const settled = workspaces.settleProject(projectId)
    return workspaces.coalesceProjectOperation(projectId, async () => {
      await settled
      return this.performPrune(projectId)
    })
  }

  /** The exact worktree `addWorktree(root, slug, commit)` would create, for a preview. */
  worktreeTarget(root: HostPath, slug: string, commit: string): HvirWorktreeTarget {
    this.assertActive(
      root,
      'Worktree creation belongs to another workspace',
      'creating a worktree',
    )
    return hvirWorktreeTarget(this.activeProject().registeredRoot, slug, commit)
  }

  /**
   * Creates the review worktree hvir owns beside the registered root, on a new
   * `hvir/architecture/<slug>` branch at `commit` (ADR-063). `root` must be the active
   * workspace; the grant names the exact branch, path and commit.
   */
  addWorktree(root: HostPath, slug: string, commit: string): Promise<AddedWorktree> {
    return this.options.workspaces.serialize(async () => {
      const { registry } = this.options
      this.assertActive(
        root,
        'Worktree creation belongs to another workspace',
        'creating a worktree',
      )
      const project = this.activeProject()
      const projectId = project.id
      const target = hvirWorktreeTarget(project.registeredRoot, slug, commit)
      const grant = this.options.authorizations.grant({
        kind: 'worktree-add',
        projectId,
        root: project.registeredRoot,
        target,
      })
      let discovery: WorktreeDiscovery
      try {
        discovery = await this.options.worker.addWorktree(project.registeredRoot, target)
      } finally {
        grant.revoke()
      }
      const state = await registry.reconcileWorktrees(projectId, discovery)
      const workspace = state.projects
        .find((candidate) => candidate.id === projectId)
        ?.workspaces.find((candidate) => candidate.root.path === target.path)
      if (!workspace) throw new Error('Git did not report the new worktree')
      return {
        projectId,
        workspaceId: workspace.id,
        root: workspace.root,
        branch: target.branch,
      }
    })
  }

  /**
   * The workspace ids of this project's unfinished handoffs (ADR-063), each judged from
   * disk and Git as `inspectUnfinishedHandoff` documents. A worktree that cannot be
   * inspected is reported and left unmarked.
   */
  async unfinishedHandoffs(projectId: string): Promise<readonly string[]> {
    const project = this.options.registry.projectById(projectId)
    if (!project || project.connectionState !== 'connected') return []
    const candidates = project.workspaces.filter(
      (workspace) =>
        !workspace.main &&
        !workspace.missing &&
        hvirWorktreeSlug(workspace.branch) !== undefined,
    )
    if (candidates.length === 0) return []
    const host = this.hostOf(project)
    const marked = await Promise.all(
      candidates.map(async (workspace) => {
        try {
          const verdict = await inspectUnfinishedHandoff(
            host,
            project.registeredRoot,
            workspace,
            this.options.removal.workspaceTerminalIds(workspace.root),
          )
          return verdict.unfinished
        } catch (error) {
          this.report(`[git] could not inspect ${workspace.root.path}`, error)
          return false
        }
      }),
    )
    return candidates.filter((_, index) => marked[index]).map((workspace) => workspace.id)
  }

  /**
   * Removes one unfinished handoff the person chose (ADR-063): re-reads Git and disk,
   * refuses unless the worktree still qualifies, runs `git worktree remove` without
   * `--force`, then deletes its branch only while it still points at its creation
   * commit. Each Git call runs under its own exact one-shot grant.
   */
  removeUnfinishedHandoff(projectId: string, workspaceId: string): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry, worker, removal, workspaces } = this.options
      const project = registry.projectById(projectId)
      if (!project) throw new Error('Unknown project')
      if (project.connectionState !== 'connected') {
        throw new Error('Connect to the project host before removing a worktree')
      }
      const workspace = project.workspaces.find(
        (candidate) => candidate.id === workspaceId,
      )
      if (!workspace) throw new Error('Unknown workspace')
      if (workspace.main) throw new Error('hvir never removes the main working tree')
      if (
        workspace.id === project.activeWorkspaceId ||
        workspace.id === registry.active.workspaceId
      ) {
        throw new Error('Select another workspace before removing this one')
      }
      const root = project.registeredRoot
      const refuse = (reason: string) =>
        new Error(`Cannot remove ${workspace.root.path}: ${reason}`)
      workspaces.invalidateProject(projectId)
      await workspaces.settleProject(projectId)
      const listed = (await worker.discover(root)).worktrees.find(
        (worktree) =>
          hostPathEquals(worktree.root, workspace.root) && worktree.prunable !== true,
      )
      if (!listed) throw refuse('Git does not list it as a worktree')
      const verdict = await inspectUnfinishedHandoff(
        this.hostOf(project),
        root,
        listed,
        removal.workspaceTerminalIds(listed.root),
      )
      if (!verdict.unfinished) throw refuse(verdict.reason)
      const { target } = verdict
      const discovery = await this.granted(
        'worktree-remove',
        projectId,
        root,
        target,
        () => worker.removeWorktree(root, target),
      )
      if (discovery.worktrees.some((worktree) => worktree.root.path === target.path)) {
        throw refuse('Git still lists it after removal')
      }
      await registry.reconcileWorktrees(projectId, discovery)
      await removal.removeMissingWorkspace(projectId, workspaceId)
      try {
        await this.granted('branch-delete', projectId, root, target, () =>
          worker.deleteHvirBranch(root, target),
        )
      } catch (error) {
        throw new Error(
          `Removed ${target.path} but kept branch ${target.branch}: ${errorMessage(error)}`,
          { cause: error },
        )
      }
      return registry.state()
    })
  }

  switchBranch(root: HostPath, branch: string): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry, workspaces } = this.options
      this.assertActive(
        root,
        'Branch switch belongs to another workspace',
        'switching branches',
      )
      if (
        typeof branch !== 'string' ||
        branch.length === 0 ||
        branch.length > 1_024 ||
        branch.includes('\0')
      ) {
        throw new Error('Invalid branch target')
      }

      const projectId = registry.active.projectId
      workspaces.invalidateProject(projectId)
      await workspaces.settleProject(projectId)
      const grant = this.options.authorizations.grant({
        kind: 'branch-switch',
        projectId,
        root,
        target: branch,
      })
      return this.mutateAndRefresh(projectId, 'branch switch', async () => {
        try {
          await this.options.worker.switchBranch(
            root,
            branch,
            this.relatedWorktreeRoots(projectId),
          )
        } finally {
          grant.revoke()
        }
      })
    })
  }

  fetch(root: HostPath): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry } = this.options
      this.assertActive(root, 'Git fetching belongs to another workspace', 'fetching')
      const grant = this.options.authorizations.grant({
        kind: 'fetch',
        projectId: registry.active.projectId,
        root,
      })
      try {
        await this.options.worker.fetch(root)
      } finally {
        grant.revoke()
      }
      return registry.state()
    })
  }

  pull(root: HostPath): Promise<ProjectState> {
    return this.options.workspaces.serialize(async () => {
      const { registry, workspaces } = this.options
      this.assertActive(root, 'Git pulling belongs to another workspace', 'pulling')
      const projectId = registry.active.projectId
      workspaces.invalidateProject(projectId)
      await workspaces.settleProject(projectId)
      const grant = this.options.authorizations.grant({
        kind: 'pull',
        projectId,
        root,
      })
      return this.mutateAndRefresh(projectId, 'pull', async () => {
        try {
          await this.options.worker.pull(root, this.relatedWorktreeRoots(projectId))
        } finally {
          grant.revoke()
        }
      })
    })
  }

  private async performPrune(projectId: string): Promise<ProjectState> {
    const { registry } = this.options
    const project = registry.projectById(projectId)
    if (!project) throw new Error('Unknown project')
    if (project.connectionState !== 'connected') {
      throw new Error('Connect to the project host before pruning worktrees')
    }
    const targets = project.workspaces.filter(
      (workspace) => workspace.missing && workspace.prunableReason !== undefined,
    )
    if (targets.length === 0) throw new Error('Git reports no prunable worktrees')
    const prunesActiveWorkspace = targets.some(
      (workspace) => workspace.id === registry.active.workspaceId,
    )

    const grant = this.options.authorizations.grant({
      kind: 'worktree-prune',
      projectId,
      root: project.registeredRoot,
    })
    let discovery: WorktreeDiscovery
    try {
      discovery = await this.options.worker.pruneWorktrees(project.registeredRoot)
    } finally {
      grant.revoke()
    }

    await registry.reconcileWorktrees(projectId, discovery)
    for (const target of targets) {
      if (
        discovery.worktrees.some((worktree) => hostPathEquals(worktree.root, target.root))
      ) {
        continue
      }
      await this.options.removal.removeMissingWorkspace(projectId, target.id)
    }
    if (prunesActiveWorkspace) {
      await this.options.workspaces.stopWatch()
      await this.options.workspaces.replaceWatch(registry.active)
    }
    return registry.state()
  }

  private async granted<T>(
    kind: 'worktree-remove' | 'branch-delete',
    projectId: string,
    root: HostPath,
    target: HvirWorktreeTarget,
    run: () => Promise<T>,
  ): Promise<T> {
    const grant = this.options.authorizations.grant({ kind, projectId, root, target })
    try {
      return await run()
    } finally {
      grant.revoke()
    }
  }

  private hostOf(project: RegisteredProjectState): ProjectHost {
    const { hostId, path } = project.registeredRoot
    const host = this.options.registry.authorityForPath(hostId, path)?.host
    if (!host) throw new Error('The project host is not connected')
    return host
  }

  private activeProject(): RegisteredProjectState {
    const project = this.options.registry.projectById(
      this.options.registry.active.projectId,
    )
    if (!project) throw new Error('Unknown project')
    return project
  }

  private assertActive(
    root: HostPath,
    wrongWorkspaceMessage: string,
    disconnectedOperation: string,
  ): void {
    const { active } = this.options.registry
    if (!hostPathEquals(root, active.root)) throw new Error(wrongWorkspaceMessage)
    if (active.host.connectionState !== 'connected') {
      throw new Error(`Reconnect before ${disconnectedOperation}`)
    }
  }

  private relatedWorktreeRoots(projectId: string): readonly HostPath[] {
    return (
      this.options.registry
        .projectById(projectId)
        ?.workspaces.filter((workspace) => !workspace.missing)
        .map((workspace) => workspace.root) ?? []
    )
  }

  private async mutateAndRefresh(
    projectId: string,
    operation: string,
    mutation: () => Promise<void>,
  ): Promise<ProjectState> {
    let succeeded = false
    let failure: unknown
    try {
      await mutation()
      succeeded = true
    } catch (error) {
      failure = error
    }
    const state = await this.refreshAfterMutation(projectId, operation)
    if (!succeeded) throw failure
    return state
  }

  private async refreshAfterMutation(
    projectId: string,
    operation: string,
  ): Promise<ProjectState> {
    try {
      return await this.options.workspaces.refresh(projectId)
    } catch (error) {
      this.report(`[git] workspace refresh after ${operation} failed`, error)
      this.options.workspaces.scheduleRefresh(projectId)
      return this.options.registry.state()
    }
  }

  private report(message: string, error: unknown): void {
    if (this.options.onError) this.options.onError(message, error)
    else console.error(message, error)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
