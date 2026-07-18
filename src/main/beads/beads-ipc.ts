import { ipcMain } from 'electron'

import type { IpcInvokeChannel, IpcRequest, IpcResponse } from '../../shared'
import type { BeadsService } from './beads-service'

/**
 * Local mirror of the typed `handle` wrapper in `src/main/ipc.ts` (same
 * main-frame assertion). Kept here so the beads module registers its channels
 * without editing the upstream handler file.
 */
function handle<C extends IpcInvokeChannel>(
  channel: C,
  handler: (req: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
): void {
  ipcMain.handle(channel, (event, req: IpcRequest<C>) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('IPC is available only to the workbench main frame')
    }
    return handler(req)
  })
}

export function registerBeadsIpcHandlers(service: BeadsService): void {
  handle('beads:list', (req) => service.list(req))
  handle('beads:probe', (req) => service.probe(req.root))
  handle('beads:watch', (req) => service.watch(req.root))
  handle('beads:unwatch', (req) => {
    service.unwatch(req.root)
  })
}
