import type {
  DiffBase,
  GitBlameRun,
  GitBranchModel,
  GitChanges,
  GitCommitDetail,
  GitDiffResponse,
  GitHistoryPage,
  HostPath,
  WorktreeDiscovery,
  WorkspaceActivityResult,
  ReviewCheckpointRequest,
  ReviewCheckpointResult,
} from '../../shared'
import { createGitCapabilities } from './git-capabilities'
import { GitCommandContext, type GitHostPort } from './git-command-context'
import type { HvirWorktreeChange } from './git-worktrees'
import type { PullWorktreeTarget } from './pull-worktrees'

export { GIT_FETCH_ARGS, GIT_PULL_ARGS } from './git-branches'
export { parseLocalBranches, parseWorktreeList } from './git-parsers'

/** Stable worker-facing façade over cohesive, host-local Git capabilities. */
export class GitEngine {
  private readonly capabilities: ReturnType<typeof createGitCapabilities>

  constructor(host: GitHostPort, projectRoot?: HostPath) {
    this.capabilities = createGitCapabilities(new GitCommandContext(host, projectRoot))
  }

  reviewCheckpoint(request: ReviewCheckpointRequest): Promise<ReviewCheckpointResult> {
    return this.capabilities.reviewCheckpoint(request)
  }

  worktrees(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    return this.capabilities.worktree.discover(projectRoot)
  }

  pruneWorktrees(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    return this.capabilities.worktree.prune(projectRoot)
  }

  workspaceActivity(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<WorkspaceActivityResult> {
    return this.capabilities.status.workspaceActivity(workspaceRoot, relatedWorktreeRoots)
  }

  branches(workspaceRoot: HostPath): Promise<GitBranchModel> {
    return this.capabilities.branch.branches(workspaceRoot)
  }

  fetch(workspaceRoot: HostPath): Promise<void> {
    return this.capabilities.branch.fetch(workspaceRoot)
  }

  pullFastForward(
    workspaceRoot: HostPath,
    _relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    return this.capabilities.branch.pullFastForward(workspaceRoot)
  }

  switchBranch(
    workspaceRoot: HostPath,
    branch: string,
    _relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    return this.capabilities.branch.switchBranch(workspaceRoot, branch)
  }

  diffInputs(
    path: HostPath,
    base: DiffBase,
    revision?: string,
  ): Promise<GitDiffResponse> {
    return this.capabilities.diff.inputs(path, base, revision)
  }

  hvirWorktree(root: HostPath, change: HvirWorktreeChange): Promise<WorktreeDiscovery> {
    return this.capabilities.worktree.change(root, change)
  }

  pullWorktree(root: HostPath, target: PullWorktreeTarget): Promise<WorktreeDiscovery> {
    return this.capabilities.worktree.addPull(root, target)
  }

  changes(
    projectRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<GitChanges> {
    return this.capabilities.status.changes(projectRoot, relatedWorktreeRoots)
  }

  ignoredEntries(
    projectRoot: HostPath,
    directory: HostPath,
    names: readonly string[],
  ): Promise<{ readonly ignoredNames: readonly string[] }> {
    return this.capabilities.status.ignoredEntries(projectRoot, directory, names)
  }
  ignoredPaths(projectRoot: HostPath, paths: readonly string[]) {
    return this.capabilities.status.ignoredPaths(projectRoot, paths)
  }

  history(
    projectRoot: HostPath,
    limit: number,
    cursor?: string,
    path?: HostPath,
    allRefs = false,
  ): Promise<GitHistoryPage> {
    return this.capabilities.history.history(projectRoot, limit, cursor, path, allRefs)
  }

  blame(path: HostPath): Promise<readonly GitBlameRun[]> {
    return this.capabilities.detail.blame(path)
  }

  commitDetail(projectRoot: HostPath, hash: string): Promise<GitCommitDetail> {
    return this.capabilities.detail.commitDetail(projectRoot, hash)
  }
}
