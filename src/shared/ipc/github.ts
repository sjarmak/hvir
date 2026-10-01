import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  PullsProbeRequest,
  PullsProbeResponse,
  PullsRequest,
  PullsResponse,
  PullCheckoutsRequest,
  PullCheckoutsResponse,
} from '../github'

export const githubIpc = {
  invoke: {
    'github:pulls': invoke<PullsRequest, PullsResponse>(),
    'github:probe': invoke<PullsProbeRequest, PullsProbeResponse>(),
    'github:checkouts': invoke<PullCheckoutsRequest, PullCheckoutsResponse>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
