import { hostPath, hostPathEquals, type HostPath } from '../../shared'
import type { GitWorkerProtocol } from '../../shared/worker-protocol'
import type { ArchitectureWorktreePort } from '../architecture-review/handoff'
import { hvirWorktreeLocation, hvirWorktreeTarget } from '../git/hvir-worktrees'
import { GitMutationAuthorization } from '../git/mutation-authorization'
import { GitWorkerHostRouter } from '../git/worker-host-router'
import { gitMutationWorker, type GitWorker } from '../git/worker-ports'
import type { ProjectHost } from '../project-host'
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
): {
  readonly git: WorkerClient<GitWorkerProtocol>
  readonly worktrees: ArchitectureWorktreePort
} {
  const { authorizations, router } = createSmokeGitAuthority(host, root, cleanup)
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
  return { git, worktrees }
}

const SMOKE_PROJECT_ID = 'smoke-project'
const SMOKE_WORKSPACE_ID = 'smoke-workspace'

/** The production grant router for the smoke Git worker, bound to the one smoke project. */
function createSmokeGitAuthority(
  host: ProjectHost,
  root: HostPath,
  cleanup: SmokeCleanup,
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
      authorityForPath: (hostId) =>
        hostId === host.hostId ? { projectId: SMOKE_PROJECT_ID, host, root } : undefined,
    },
  })
  return { authorizations, router }
}

/**
 * Worktree creation for the smoke project through the production grant and broker: an
 * exact `worktree-add` grant, the real Git worker, and the router's argv check. The smoke
 * project fixture holds one workspace, so the handoff switches back to it.
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
      return {
        projectId: SMOKE_PROJECT_ID,
        workspaceId: SMOKE_WORKSPACE_ID,
        root: hostPath(root.hostId, exact.path),
        branch: exact.branch,
      }
    },
  }
}
