import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type GasCityIpcDeps = Pick<IpcDeps, 'gascity'>

export function registerGasCityIpc(ipc: IpcRegistrar, deps: GasCityIpcDeps): void {
  ipc.handle('gascity:crew', (req) => deps.gascity.crew(req))
  ipc.handle('gascity:probe', (req) => deps.gascity.probe(req.root))
}
