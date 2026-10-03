import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type {
  NeedsYouChangedEvent,
  NeedsYouDemandRequest,
  NeedsYouSnapshot,
} from '../needs-you'

export const needsYouIpc = {
  invoke: {
    'needs-you:observe': invoke<NeedsYouDemandRequest, NeedsYouSnapshot>(),
    'needs-you:snapshot': invoke<NeedsYouDemandRequest, NeedsYouSnapshot>(),
    'needs-you:release': invoke<NeedsYouDemandRequest, void>(),
  },
  send: {},
  event: { 'needs-you:changed': payload<NeedsYouChangedEvent>() },
} satisfies IpcFeatureContract
