import {
  containsHostPath,
  hostPath,
  hostPathEquals,
  type HostPath,
  type ProjectState,
} from '../../shared'
import type { GitWorkerProtocol } from '../../shared/worker-protocol'
import type { ArchitectureWorktreePort } from '../architecture-review/handoff'
import { hvirWorktreeLocation, hvirWorktreeTarget } from '../git/hvir-worktrees'
import { GitMutationAuthorization } from '../git/mutation-authorization'
import type { AddedWorktree, HeldWorktree } from '../git/mutation-coordinator'
import { GitWorkerHostRouter } from '../git/worker-host-router'
import { ReviewCheckpointCoordinator } from '../git/review-checkpoint-coordinator'
import { ReviewCheckpointHost } from '../git/review-checkpoint-host'
import { gitMutationWorker, type GitWorker } from '../git/worker-ports'
import type { ProjectHost } from '../project-host'
import { RendererResourceScopes } from '../renderer-resource-scopes'
import { createWorkerClient, workerPath, type WorkerClient } from '../worker-host'
import type { SmokeCleanup } from './cleanup'

/**
 * The smoke Git worker behind the production grant router, and the review worktree port
 * that creates a handoff worktree through it.
 */
export function createSmokeGitWorker(
  host: ProjectHost,
  root: HostPath,
  cleanup: SmokeCleanup,
  options?: {
    readonly projectState?: () => ProjectState
    readonly resources?: RendererResourceScopes
  },
): {
  readonly git: WorkerClient<GitWorkerProtocol>
  readonly worktrees: ArchitectureWorktreePort
  readonly reviewCheckpoint: ReviewCheckpointCoordinator
} {
  const checkpoints = cleanup.acquire(
    'review checkpoint host',
    () => new ReviewCheckpointHost(),
    (owned) => owned.dispose(),
  )
  const { authorizations, router } = createSmokeGitAuthority(
    host,
    root,
    cleanup,
    checkpoints,
    options?.projectState,
  )
  const git = cleanup.acquire(
    'Git worker',
    () =>
      createWorkerClient<GitWorkerProtocol>(
        workerPath('git-worker.js'),
        'hvir-git-smoke',
        (call) => router.route(call),
      ),
    (worker) => worker.dispose(),
  )
  const worktrees = smokeArchitectureWorktrees(host, root, git, authorizations, cleanup)
  const reviewCheckpoint = cleanup.acquire(
    'review checkpoint coordinator',
    () =>
      new ReviewCheckpointCoordinator({
        registry: smokeCheckpointRegistry(host, root, options?.projectState) as never,
        worker: git,
        checkpoints,
        resources: options?.resources ?? new RendererResourceScopes(),
      }),
    (coordinator) => coordinator.dispose(),
  )
  return { git, worktrees, reviewCheckpoint }
}

const SMOKE_PROJECT_ID = 'smoke-project'
const SMOKE_WORKSPACE_ID = 'smoke-workspace'

/** The production grant router for the smoke Git worker, bound to the one smoke project. */
function createSmokeGitAuthority(
  host: ProjectHost,
  root: HostPath,
  cleanup: SmokeCleanup,
  checkpoints: ReviewCheckpointHost,
  projectState?: () => ProjectState,
): {
  readonly authorizations: GitMutationAuthorization
  readonly router: GitWorkerHostRouter
} {
  const authorizations = cleanup.acquire(
    'Git mutation authorizations',
    () => new GitMutationAuthorization(),
    (owned) => owned.dispose(),
  )
  const router = new GitWorkerHostRouter({
    authorizations,
    authority: {
      authorityForPath: (hostId, path) =>
        hostId === host.hostId
          ? projectAuthority(host, root, path, projectState?.())
          : undefined,
    },
    checkpoints,
  })
  return { authorizations, router }
}

function projectAuthority(
  host: ProjectHost,
  root: HostPath,
  path: string,
  state?: ProjectState,
) {
  const candidate = hostPath(host.hostId, path)
  if (state && containsHostPath(state.root, candidate))
    return { projectId: state.activeProjectId, host, root: state.root }
  if (containsHostPath(root, candidate))
    return { projectId: SMOKE_PROJECT_ID, host, root }
  return undefined
}

function smokeCheckpointRegistry(
  host: ProjectHost,
  root: HostPath,
  projectState?: () => ProjectState,
) {
  const fallback = {
    projectId: SMOKE_PROJECT_ID,
    workspaceId: SMOKE_WORKSPACE_ID,
    root,
    host,
  }
  return {
    get active() {
      const state = projectState?.()
      const activeWorkspaceId = state?.activeWorkspaceId
      const project = state?.projects.find(
        (candidate) => candidate.id === state.activeProjectId,
      )
      const workspace = project?.workspaces.find(
        (candidate) => candidate.id === activeWorkspaceId,
      )
      return project && workspace
        ? { projectId: project.id, workspaceId: workspace.id, root: workspace.root, host }
        : fallback
    },
  }
}

/**
 * Worktree creation for the smoke project through the production grant and broker: an
 * exact `worktree-add` grant, the real Git worker, and the router's argv check. The smoke
 * project fixture holds one workspace, so the handoff switches back to it. The smoke
 * offers no unfinished-handoff removal, so holding a worktree in flight guards nothing.
 */
function smokeArchitectureWorktrees(
  host: ProjectHost,
  root: HostPath,
  git: GitWorker,
  authorizations: GitMutationAuthorization,
  cleanup: SmokeCleanup,
): ArchitectureWorktreePort {
  const location = hvirWorktreeLocation(root)
  cleanup.defer('architecture handoff worktrees', async () => {
    const removed = await host.exec('rm', ['-rf', '--', location])
    if (removed.code !== 0) throw new Error(`Failed to remove ${location}`)
  })
  const target = (candidate: HostPath, slug: string, commit: string) => {
    if (!hostPathEquals(candidate, root))
      throw new Error('Worktree creation belongs to another workspace')
    return hvirWorktreeTarget(root, slug, commit)
  }
  return {
    worktreeTarget: target,
    addWorktree: async (candidate, slug, commit) => {
      const exact = target(candidate, slug, commit)
      const grant = authorizations.grant({
        kind: 'worktree-add',
        projectId: SMOKE_PROJECT_ID,
        root,
        target: exact,
      })
      try {
        await gitMutationWorker(git).addWorktree(root, exact)
      } finally {
        grant.revoke()
      }
      return unguarded({
        projectId: SMOKE_PROJECT_ID,
        workspaceId: SMOKE_WORKSPACE_ID,
        root: hostPath(root.hostId, exact.path),
        branch: exact.branch,
      })
    },
    holdWorktree: (added) => Promise.resolve(unguarded(added)),
  }
}

function unguarded(added: AddedWorktree): HeldWorktree {
  return { added, release: () => undefined }
}
