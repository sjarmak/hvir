import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type BeadsIpcDeps = Pick<IpcDeps, 'beads'>

export function registerBeadsIpc(ipc: IpcRegistrar, deps: BeadsIpcDeps): void {
  ipc.handle('beads:list', (req) => deps.beads.list(req))
  ipc.handle('beads:probe', (req) => deps.beads.probe(req.root))
  ipc.handle('beads:watch', (req) => deps.beads.watch(req.root))
  ipc.handle('beads:unwatch', (req) => deps.beads.unwatch(req.root))
}
