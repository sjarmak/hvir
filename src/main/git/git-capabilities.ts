import { GitBranchCapability } from './git-branches'
import type { GitCommandContext } from './git-command-context'
import { GitDetailCapability } from './git-detail'
import { GitDiffCapability } from './git-diff'
import { GitHistoryCapability } from './git-history'
import { GitStatusCapability } from './git-status'
import { GitWorktreeCapability } from './git-worktrees'
import type { ReviewCheckpointRequest } from '../../shared'
import { ReviewCheckpointCapability } from './review-checkpoint-capability'

export function createGitCapabilities(context: GitCommandContext) {
  const worktree = new GitWorktreeCapability(context)
  return {
    worktree,
    status: new GitStatusCapability(context),
    branch: new GitBranchCapability(context, worktree),
    diff: new GitDiffCapability(context),
    history: new GitHistoryCapability(context),
    detail: new GitDetailCapability(context),
    reviewCheckpoint: (request: ReviewCheckpointRequest) => {
      const call = context.host.reviewCheckpoint?.bind(context.host)
      if (!call) throw new Error('Checkpoint transport is unavailable')
      const capability = new ReviewCheckpointCapability(
        { call: (input) => call(request.root, input) },
        request.root,
      )
      switch (request.action) {
        case 'status':
          return capability.status()
        case 'capture':
          return capability.capture()
        case 'clear':
          return capability.clear()
        case 'diff':
          return capability.diff(request.checkpoint, request.change)
      }
    },
  }
}
