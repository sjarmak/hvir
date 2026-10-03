import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  PullsProbeRequest,
  PullsProbeResponse,
  PullsRequest,
  PullsResponse,
  PullCheckoutsRequest,
  PullCheckoutsResponse,
  PullDetailRequest,
  PullDetailResponse,
} from '../github'

export const githubIpc = {
  invoke: {
    'github:pulls': invoke<PullsRequest, PullsResponse>(),
    'github:probe': invoke<PullsProbeRequest, PullsProbeResponse>(),
    'github:checkouts': invoke<PullCheckoutsRequest, PullCheckoutsResponse>(),
    'github:detail': invoke<PullDetailRequest, PullDetailResponse>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
