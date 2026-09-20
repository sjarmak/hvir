import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  BeadsListRequest,
  BeadsListResponse,
  BeadsProbeRequest,
  BeadsProbeResponse,
} from '../beads'

/** Beads (bd) issue tracker: list and probe a workspace's tracker. */
export const beadsIpc = {
  invoke: {
    'beads:list': invoke<BeadsListRequest, BeadsListResponse>(),
    'beads:probe': invoke<BeadsProbeRequest, BeadsProbeResponse>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
