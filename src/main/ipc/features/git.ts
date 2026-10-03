import {
  GIT_BLAME_TYPE,
  GIT_BRANCHES_TYPE,
  GIT_CHANGES_TYPE,
  GIT_COMMIT_DETAIL_TYPE,
  GIT_DIFF_INPUTS_TYPE,
  GIT_HISTORY_TYPE,
  GIT_IGNORED_ENTRIES_TYPE,
} from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'
import type { ReviewCheckpointCoordinator } from '../../git/review-checkpoint-coordinator'

type GitIpcDeps = Pick<
  IpcDeps,
  'getProject' | 'gitWorker' | 'fetchGit' | 'pullGit' | 'switchGitBranch'
> & { readonly reviewCheckpoint: Pick<ReviewCheckpointCoordinator, 'request' | 'cancel'> }

export function registerGitIpc(ipc: IpcRegistrar, deps: GitIpcDeps): void {
  ipc.handle('git:diff-inputs', async (req) => {
    const { root, host } = deps.getProject()
    // Historical/deleted Git entries legitimately have no live leaf. Their
    // existing parent is still canonicalized before the worker may inspect
    // repository blobs, so this does not turn into a lexical-only bypass.
    const path = await ipc.authority.projectPath(req.path, root, host, {
      allowMissingLeaf: true,
    })
    return deps.gitWorker.request(GIT_DIFF_INPUTS_TYPE, {
      path,
      base: req.base,
      revision: req.revision,
      root,
    })
  })

  ipc.handle('git:changes', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_CHANGES_TYPE, {
      root,
      relatedWorktreeRoots: ipc.authority.worktreeRoots(root),
    })
  })

  ipc.handle('git:history', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    const path = req.path
      ? await ipc.authority.projectPath(req.path, project.root, project.host)
      : undefined
    return deps.gitWorker.request(GIT_HISTORY_TYPE, {
      root,
      path,
      limit: req.limit,
      cursor: req.cursor,
      allRefs: req.allRefs,
    })
  })

  ipc.handle('git:ignored-entries', async (req) => {
    const project = deps.getProject()
    const [root, directory] = await Promise.all([
      ipc.authority.projectPath(req.root, project.root, project.host),
      ipc.authority.projectPath(req.directory, project.root, project.host),
    ])
    return deps.gitWorker.request(GIT_IGNORED_ENTRIES_TYPE, {
      root,
      directory,
      names: req.names,
    })
  })

  ipc.handle('git:commit-detail', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_COMMIT_DETAIL_TYPE, { root, hash: req.hash })
  })

  ipc.handle('git:blame', async (req) => {
    const { root, host } = deps.getProject()
    const path = await ipc.authority.projectPath(req.path, root, host)
    return deps.gitWorker.request(GIT_BLAME_TYPE, { root, path })
  })

  ipc.handle('git:branches', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_BRANCHES_TYPE, { root })
  })

  ipc.handle('git:fetch', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      return deps.fetchGit(root)
    }),
  )

  ipc.handle('git:pull', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      return deps.pullGit(root)
    }),
  )

  ipc.handle('git:switch-branch', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      return deps.switchGitBranch(root, req.branch)
    }),
  )

  ipc.handle('git:review-checkpoint', async (req, context) => {
    assertReviewCheckpointRequest(req)
    const owner = context.owner()
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    const { id, ...checkpointRequest } = req
    return deps.reviewCheckpoint.request(owner, id, { ...checkpointRequest, root })
  })
  ipc.handleSend('git:review-checkpoint-cancel', (req, context) => {
    if (!isCheckpointCancel(req)) return
    void deps.reviewCheckpoint.cancel(context.owner(), req.id)
  })
}

function isCheckpointCancel(value: unknown): value is { readonly id: string } {
  const id =
    typeof value === 'object' && value !== null
      ? (value as { id?: unknown }).id
      : undefined
  return typeof id === 'string' && id.length > 0 && id.length <= 128
}

function assertReviewCheckpointRequest(value: unknown): void {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid review checkpoint request')
  const candidate = value as {
    id?: unknown
    action?: unknown
    root?: unknown
    checkpoint?: unknown
    change?: unknown
  }
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    candidate.id.length > 128 ||
    !isCheckpointPath(candidate.root) ||
    typeof candidate.action !== 'string' ||
    !['status', 'capture', 'clear', 'diff'].includes(candidate.action)
  )
    throw new Error('Invalid review checkpoint request')
  if (candidate.action === 'diff') {
    if (
      typeof candidate.checkpoint !== 'string' ||
      candidate.checkpoint.length === 0 ||
      candidate.checkpoint.length > 128 ||
      !candidate.change ||
      typeof candidate.change !== 'object'
    )
      throw new Error('Invalid review checkpoint diff request')
    const change = candidate.change as {
      path?: unknown
      before?: unknown
      after?: unknown
    }
    if (
      !isCheckpointPath(change.path) ||
      !isCheckpointObject(change.before) ||
      !isCheckpointObject(change.after)
    )
      throw new Error('Invalid review checkpoint diff request')
  }
}

function isCheckpointPath(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { hostId?: unknown; path?: unknown }
  return (
    typeof candidate.hostId === 'string' &&
    candidate.hostId.length > 0 &&
    candidate.hostId.length <= 128 &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    candidate.path.length <= 16_384
  )
}

function isCheckpointObject(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const candidate = value as { mode?: unknown; oid?: unknown }
  return (
    (candidate.mode === '100644' ||
      candidate.mode === '100755' ||
      candidate.mode === '120000') &&
    typeof candidate.oid === 'string' &&
    candidate.oid.length > 0 &&
    candidate.oid.length <= 128
  )
}
