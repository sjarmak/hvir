import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type GasCityIpcDeps = Pick<IpcDeps, 'getExternalAttention'>

export function registerGasCityIpc(ipc: IpcRegistrar, deps: GasCityIpcDeps): void {
  ipc.handle('gascity:attention', () => deps.getExternalAttention())
}
