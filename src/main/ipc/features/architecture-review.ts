import { hostPathEquals, type HostPath } from '../../../shared/host-path'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { reconstructIpcHostPath } from '../host-path-authority'
type Deps = Pick<IpcDeps, 'getProject' | 'architectureReview'>
export function registerArchitectureReviewIpc(ipc: IpcRegistrar, deps: Deps): void {
  function project(request: { readonly root: HostPath }) {
    const root = reconstructIpcHostPath(request.root)
    const active = deps.getProject()
    if (!hostPathEquals(root, active.root))
      throw new Error('Architecture review is not in the active workspace')
    return active
  }
  ipc.handle('architecture-review:scan', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    await ipc.authority.projectPath(request.root, active.root, active.host)
    project(request)
    const result = await deps.architectureReview.scan(owner, active.host, request)
    context.owner()
    if (
      !hostPathEquals(deps.getProject().root, active.root) ||
      deps.getProject().host !== active.host
    ) {
      deps.architectureReview.close(owner, request)
      throw new Error('Architecture workspace changed')
    }
    return result
  })
  ipc.handle('architecture-review:evidence', async (request, context) => {
    const active = project(request)
    await ipc.authority.projectPath(request.root, active.root, active.host)
    reconstructIpcHostPath(request.path)
    const result = await deps.architectureReview.evidence(
      context.owner(),
      active.host,
      request,
    )
    context.owner()
    project(request)
    return result
  })
  ipc.handle('architecture-review:prepare', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    await ipc.authority.projectPath(request.root, active.root, active.host)
    reconstructIpcHostPath(request.path)
    project(request)
    const result = await deps.architectureReview.prepare(owner, active.host, request)
    context.owner()
    project(request)
    return result
  })
  ipc.handle('architecture-review:commits', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    await ipc.authority.projectPath(request.root, active.root, active.host)
    const result = await deps.architectureReview.commits(owner, active.host, request)
    context.owner()
    project(request)
    return result
  })
  // Closing a previous workspace's own lease remains possible after navigation.
  ipc.handle('architecture-review:close', (request, context) => {
    reconstructIpcHostPath(request.root)
    deps.architectureReview.close(context.owner(), request)
  })
}
