import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  GasCityCrewRequest,
  GasCityCrewResponse,
  GasCityProbeRequest,
  GasCityProbeResponse,
} from '../gascity'
import type { GasCityAnalyticsConfig, GasCityAnalyticsConfigRequest } from '../gascity-analytics'

/** Gas City (gc) crew roster and CLI probe for a workspace. */
export const gascityIpc = {
  invoke: {
    'gascity:crew': invoke<GasCityCrewRequest, GasCityCrewResponse>(),
    'gascity:probe': invoke<GasCityProbeRequest, GasCityProbeResponse>(),
    'gascity:analytics-config': invoke<GasCityAnalyticsConfigRequest, GasCityAnalyticsConfig>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
