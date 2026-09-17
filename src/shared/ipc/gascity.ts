import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type {
  GasCityCrewRequest,
  GasCityCrewResponse,
  GasCityProbeRequest,
  GasCityProbeResponse,
} from '../gascity'
import type {
  GasCityAnalyticsConfig,
  GasCityAnalyticsConfigRequest,
} from '../gascity-analytics'
import type { ExternalAttentionSnapshot } from '../external-attention'

/**
 * Gas City (gc) crew roster and CLI probe for a workspace, plus the attention
 * external agents raise. The attention surface is read-only here: answering an
 * interaction is a Sessions mutation, not a gas city one.
 */
export const gascityIpc = {
  invoke: {
    'gascity:crew': invoke<GasCityCrewRequest, GasCityCrewResponse>(),
    'gascity:probe': invoke<GasCityProbeRequest, GasCityProbeResponse>(),
    'gascity:analytics-config': invoke<
      GasCityAnalyticsConfigRequest,
      GasCityAnalyticsConfig
    >(),
    'gascity:attention': invoke<void, ExternalAttentionSnapshot>(),
  },
  send: {},
  event: {
    'gascity:attention-changed': payload<ExternalAttentionSnapshot>(),
  },
} satisfies IpcFeatureContract
