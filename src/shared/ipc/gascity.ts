import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type { ExternalAttentionSnapshot } from '../external-attention'

export const gascityIpc = {
  invoke: {
    'gascity:attention': invoke<void, ExternalAttentionSnapshot>(),
  },
  send: {},
  event: {
    'gascity:attention-changed': payload<ExternalAttentionSnapshot>(),
  },
} satisfies IpcFeatureContract
