import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type GitHubIpcDeps = Pick<IpcDeps, 'github' | 'getProject' | 'createPullWorktree'>

export function registerGitHubIpc(ipc: IpcRegistrar, deps: GitHubIpcDeps): void {
  ipc.handle('github:pulls', (req) => deps.github.pulls(req))
  ipc.handle('github:probe', (req) => deps.github.probe(req.root))
  ipc.handle('github:checkouts', (req) => deps.github.checkouts(req))
  ipc.handle('github:detail', (req) => deps.github.detail(req))
  ipc.handle('github:create-worktree', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      const source = await deps.github.pullWorktreeSource(root, req.number)
      return deps.createPullWorktree(root, source)
    }),
  )
}
