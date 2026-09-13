import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type {
  BeadsChangedEvent,
  BeadsListRequest,
  BeadsListResponse,
  BeadsProbeRequest,
  BeadsProbeResponse,
  BeadsWatchRequest,
} from '../beads'

/** Beads (bd) issue tracker: list, probe, and watch a workspace's tracker. */
export const beadsIpc = {
  invoke: {
    'beads:list': invoke<BeadsListRequest, BeadsListResponse>(),
    'beads:probe': invoke<BeadsProbeRequest, BeadsProbeResponse>(),
    'beads:watch': invoke<BeadsWatchRequest, void>(),
    'beads:unwatch': invoke<BeadsWatchRequest, void>(),
  },
  send: {},
  event: {
    'beads:changed': payload<BeadsChangedEvent>(),
  },
} satisfies IpcFeatureContract
