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
  PullWorktreeRequest,
} from '../github'
import type { OperationResult } from '../operation-result'
import type { ProjectState } from '../workspace-types'

export const githubIpc = {
  invoke: {
    'github:pulls': invoke<PullsRequest, PullsResponse>(),
    'github:probe': invoke<PullsProbeRequest, PullsProbeResponse>(),
    'github:checkouts': invoke<PullCheckoutsRequest, PullCheckoutsResponse>(),
    'github:detail': invoke<PullDetailRequest, PullDetailResponse>(),
    'github:create-worktree': invoke<PullWorktreeRequest, OperationResult<ProjectState>>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
