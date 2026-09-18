/**
 * The git worker as the two ports main's coordinators consume: worktree
 * discovery for the workspace coordinator and the mutation verbs for the git
 * mutation coordinator. Each verb is one typed request over the worker client.
 */
import {
  GIT_FETCH_TYPE,
  GIT_PRUNE_WORKTREES_TYPE,
  GIT_PULL_TYPE,
  GIT_SWITCH_BRANCH_TYPE,
  GIT_WORKSPACE_ACTIVITY_TYPE,
  GIT_WORKTREES_TYPE,
  type GitWorkerProtocol,
} from '../../shared'
import type { WorkerClient } from '../worker-host'
import type { WorkspaceDiscoveryPort } from '../workspace-coordinator'
import type { GitMutationWorkerPort } from './mutation-coordinator'

export type GitWorker = Pick<WorkerClient<GitWorkerProtocol>, 'request'>

export function gitDiscoveryWorker(worker: GitWorker): WorkspaceDiscoveryPort {
  return {
    discover: (root) => worker.request(GIT_WORKTREES_TYPE, { root }),
    workspaceActivity: (root, relatedWorktreeRoots) =>
      worker.request(GIT_WORKSPACE_ACTIVITY_TYPE, { root, relatedWorktreeRoots }),
  }
}

export function gitMutationWorker(worker: GitWorker): GitMutationWorkerPort {
  return {
    pruneWorktrees: (root) => worker.request(GIT_PRUNE_WORKTREES_TYPE, { root }),
    switchBranch: (root, branch, relatedWorktreeRoots) =>
      worker.request(GIT_SWITCH_BRANCH_TYPE, { root, branch, relatedWorktreeRoots }),
    fetch: (root) => worker.request(GIT_FETCH_TYPE, { root }),
    pull: (root, relatedWorktreeRoots) =>
      worker.request(GIT_PULL_TYPE, { root, relatedWorktreeRoots }),
  }
}
