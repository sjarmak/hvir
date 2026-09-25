import type { HostPath, WorktreeDiscovery } from '../../shared'
import { gitError, type GitCommandContext } from './git-command-context'
import { parseLegacyWorktreeList, parseWorktreeList } from './git-parsers'
import type { HvirWorktreeTarget } from './hvir-worktrees'

export type { HvirWorktreeTarget }

export interface HvirWorktreeChange {
  readonly operation: 'add' | 'remove' | 'delete-branch'
  readonly target: HvirWorktreeTarget
}

export class GitWorktreeCapability {
  constructor(private readonly context: GitCommandContext) {}

  async discover(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    this.context.assertHost(projectRoot)
    const args = ['worktree', 'list', '--porcelain', '-z'] as const
    const result = await this.context.readOnly(projectRoot, args)
    if (result.code !== 0) {
      if (result.code === 129 || result.code === null) {
        const legacyArgs = ['worktree', 'list', '--porcelain'] as const
        const legacy = await this.context.readOnly(projectRoot, legacyArgs)
        if (legacy.code !== 0) {
          throw gitError(legacyArgs, legacy.stderr, legacy.code)
        }
        const worktrees = parseLegacyWorktreeList(legacy.stdout, projectRoot.hostId)
        if (worktrees.length === 0) throw new Error('git reported no worktrees')
        return { repository: true, worktrees }
      }
      if (await this.context.project(projectRoot)) {
        throw gitError(args, result.stderr, result.code)
      }
      return {
        repository: false,
        worktrees: [{ root: projectRoot, detached: false, bare: false }],
      }
    }
    const worktrees = parseWorktreeList(result.stdout, projectRoot.hostId)
    if (worktrees.length === 0) throw new Error('git reported no worktrees')
    return { repository: true, worktrees }
  }

  async prune(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    this.context.assertHost(projectRoot)
    const args = ['worktree', 'prune', '--expire', 'now', '--verbose'] as const
    const result = await this.context.mutate(projectRoot, args)
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return this.discover(projectRoot)
  }

  /**
   * Adds the worktree a review handoff owns, removes it without `--force`, or deletes its
   * branch only while the branch still points at its creation commit. Main grants exactly
   * the argv each operation builds (ADR-063).
   */
  async change(
    projectRoot: HostPath,
    change: HvirWorktreeChange,
  ): Promise<WorktreeDiscovery> {
    this.context.assertHost(projectRoot)
    const args = hvirWorktreeArgs(change)
    const result = await this.context.mutate(projectRoot, args)
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return this.discover(projectRoot)
  }
}

function hvirWorktreeArgs({ operation, target }: HvirWorktreeChange): readonly string[] {
  switch (operation) {
    case 'add':
      return ['worktree', 'add', '-b', target.branch, target.path, target.commit]
    case 'remove':
      return ['worktree', 'remove', target.path]
    case 'delete-branch':
      return ['update-ref', '-d', `refs/heads/${target.branch}`, target.commit]
  }
}
