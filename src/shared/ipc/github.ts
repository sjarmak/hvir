import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  PullsProbeRequest,
  PullsProbeResponse,
  PullsRequest,
  PullsResponse,
} from '../github'

export const githubIpc = {
  invoke: {
    'github:pulls': invoke<PullsRequest, PullsResponse>(),
    'github:probe': invoke<PullsProbeRequest, PullsProbeResponse>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
