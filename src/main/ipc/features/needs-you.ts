import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { rendererDemandOwner } from '../../sessions/sessions-demand-owner'

type NeedsYouIpcDeps = Pick<IpcDeps, 'needsYou' | 'rendererResources'>

export function registerNeedsYouIpc(ipc: IpcRegistrar, deps: NeedsYouIpcDeps): void {
  ipc.handle('needs-you:observe', (request, context) => {
    assertDemandRequest(request)
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const demandOwner = rendererDemandOwner(owner)
    const resource = deps.rendererResources.register(
      owner,
      { lifetime: 'renderer', type: 'needs-you-observation' },
      () => {
        deps.needsYou.release(demandOwner, request.demandGeneration)
      },
      { duplicate: 'reuse' },
    )
    return deps.needsYou.acquire(demandOwner, request).catch(async (error) => {
      if (deps.needsYou.release(demandOwner, request.demandGeneration)) {
        await resource.dispose()
      }
      throw error
    })
  })

  ipc.handle('needs-you:snapshot', (request, context) => {
    assertDemandRequest(request)
    return deps.needsYou.snapshot(rendererDemandOwner(context.owner()), request)
  })

  ipc.handle('needs-you:release', async (request, context) => {
    assertDemandRequest(request)
    const owner = context.owner()
    const demandOwner = rendererDemandOwner(owner)
    if (deps.needsYou.release(demandOwner, request.demandGeneration)) {
      await deps.rendererResources.disposeResource(owner, 'needs-you-observation')
    }
  })
}

function assertDemandRequest(request: unknown): asserts request is { readonly demandGeneration: number } {
  const candidate =
    typeof request === 'object' && request !== null && 'demandGeneration' in request
      ? request.demandGeneration
      : undefined
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate <= 0
  ) {
    throw new Error('Invalid Needs you demand generation')
  }
}
