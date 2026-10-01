import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type GitHubIpcDeps = Pick<IpcDeps, 'github'>

export function registerGitHubIpc(ipc: IpcRegistrar, deps: GitHubIpcDeps): void {
  ipc.handle('github:pulls', (req) => deps.github.pulls(req))
  ipc.handle('github:probe', (req) => deps.github.probe(req.root))
  ipc.handle('github:checkouts', (req) => deps.github.checkouts(req))
}
