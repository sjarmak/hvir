import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  GasCityCrewRequest,
  GasCityCrewResponse,
  GasCityProbeRequest,
  GasCityProbeResponse,
} from '../gascity'

/** Gas City (gc) crew roster and CLI probe for a workspace. */
export const gascityIpc = {
  invoke: {
    'gascity:crew': invoke<GasCityCrewRequest, GasCityCrewResponse>(),
    'gascity:probe': invoke<GasCityProbeRequest, GasCityProbeResponse>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
