import { hostPathEquals, joinHostPath, type HostPath } from '../../../shared/host-path'
import { ARCHITECTURE_LAYOUT_FILE } from '../../../shared/architecture-layout'
import { ARCHITECTURE_BRIEF_FILE } from '../../../shared/architecture-handoff'
import { readArchitectureBriefOrigin } from '../../architecture-review/handoff'
import { architectureScanOutcome } from '../../architecture-review/scope-cap'
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
    const result = await architectureScanOutcome(
      deps.architectureReview.scan(owner, active.host, request),
    )
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
  ipc.handle('architecture-review:handoff', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    await ipc.authority.projectPath(request.root, active.root, active.host)
    reconstructIpcHostPath(request.path)
    project(request)
    const result = await deps.architectureReview.handoff(owner, active.host, request)
    context.owner()
    return result
  })
  ipc.handle('architecture-review:prepare-explanation', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    await ipc.authority.projectPath(request.root, active.root, active.host)
    project(request)
    const result = await deps.architectureReview.prepareExplanation(
      owner,
      active.host,
      request,
    )
    context.owner()
    project(request)
    return result
  })
  ipc.handle('architecture-review:handoff-explanation', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    await ipc.authority.projectPath(request.root, active.root, active.host)
    project(request)
    const result = await deps.architectureReview.handoffExplanation(
      owner,
      active.host,
      request,
      (state) => {
        if (!context.sender.isDestroyed())
          context.sender.send('architecture-review:explanation-changed', {
            root: request.root,
            reviewId: request.reviewId,
            snapshotId: request.snapshotId,
            state,
          })
      },
    )
    context.owner()
    return result
  })
  ipc.handle('architecture-review:explanation', async (request, context) => {
    const active = project(request)
    await ipc.authority.projectPath(request.root, active.root, active.host)
    return deps.architectureReview.explanation(context.owner(), active.host, request)
  })
  ipc.handle('architecture-review:origin', async (request, context) => {
    const active = project(request)
    context.owner()
    const file = await ipc.authority.projectPath(
      joinHostPath(active.root, ARCHITECTURE_BRIEF_FILE),
      active.root,
      active.host,
      { allowMissingLeaf: true, returnCanonical: true },
    )
    project(request)
    const origin = await readArchitectureBriefOrigin(active.host, file)
    context.owner()
    return origin
  })
  ipc.handle('architecture-review:scope', async (request, context) => {
    const active = project(request)
    const owner = context.owner()
    const file = await ipc.authority.projectPath(
      joinHostPath(active.root, ARCHITECTURE_LAYOUT_FILE),
      active.root,
      active.host,
      { allowMissingLeaf: true, returnCanonical: true },
    )
    project(request)
    return deps.architectureReview.recordScope(owner, active.host, file, request)
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
  ipc.handle('architecture-review:follow', async (request, context) => {
    const active = project(request)
    await ipc.authority.projectPath(request.root, active.root, active.host)
    const owner = context.owner()
    deps.architectureReview.follow(owner, active.host, request, () => {
      if (!context.sender.isDestroyed())
        context.sender.send('architecture-review:changed', request)
    })
  })
  ipc.handle('architecture-review:pause', (request, context) => {
    project(request)
    deps.architectureReview.pause(context.owner(), request)
  })
  // Closing a previous workspace's own lease remains possible after navigation.
  ipc.handle('architecture-review:close', (request, context) => {
    reconstructIpcHostPath(request.root)
    deps.architectureReview.close(context.owner(), request)
  })
}
