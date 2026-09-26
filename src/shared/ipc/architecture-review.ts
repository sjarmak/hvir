import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import type {
  ArchitectureScanOutcome,
  ArchitectureScopeRecord,
  ArchitectureScopeRequest,
} from '../architecture-scope'
import type {
  ArchitectureReviewRequest,
  ArchitectureReviewKey,
  ArchitectureEvidenceRequest,
  ArchitectureEvidence,
  ArchitecturePreparedReview,
  ArchitectureCommitRangeRequest,
  ArchitectureCommitRange,
  ArchitectureReviewLaunch,
  ArchitectureReviewChanged,
} from '../architecture-review'
import type {
  ArchitectureHandoff,
  ArchitectureHandoffOrigin,
  ArchitectureOriginRequest,
} from '../architecture-handoff'
export const architectureReviewIpc = {
  invoke: {
    'architecture-review:scan': invoke<
      ArchitectureReviewRequest,
      ArchitectureScanOutcome
    >(),
    'architecture-review:scope': invoke<
      ArchitectureScopeRequest,
      ArchitectureScopeRecord
    >(),
    'architecture-review:evidence': invoke<
      ArchitectureEvidenceRequest,
      ArchitectureEvidence
    >(),
    'architecture-review:prepare': invoke<
      ArchitectureEvidenceRequest,
      ArchitecturePreparedReview
    >(),
    'architecture-review:handoff': invoke<ArchitectureReviewLaunch, ArchitectureHandoff>(),
    'architecture-review:origin': invoke<
      ArchitectureOriginRequest,
      ArchitectureHandoffOrigin | null
    >(),
    'architecture-review:commits': invoke<
      ArchitectureCommitRangeRequest,
      ArchitectureCommitRange
    >(),
    'architecture-review:close': invoke<ArchitectureReviewKey, void>(),
    'architecture-review:follow': invoke<ArchitectureReviewKey, void>(),
    'architecture-review:pause': invoke<ArchitectureReviewKey, void>(),
  },
  send: {},
  event: {
    'architecture-review:changed': payload<ArchitectureReviewChanged>(),
  },
} satisfies IpcFeatureContract
