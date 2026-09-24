import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  ArchitectureReviewRequest,
  ArchitectureReviewSnapshot,
  ArchitectureReviewKey,
  ArchitectureEvidenceRequest,
  ArchitectureEvidence,
  ArchitecturePreparedReview,
  ArchitectureCommitRangeRequest,
  ArchitectureCommitRange,
} from '../architecture-review'
export const architectureReviewIpc = {
  invoke: {
    'architecture-review:scan': invoke<
      ArchitectureReviewRequest,
      ArchitectureReviewSnapshot
    >(),
    'architecture-review:evidence': invoke<
      ArchitectureEvidenceRequest,
      ArchitectureEvidence
    >(),
    'architecture-review:prepare': invoke<
      ArchitectureEvidenceRequest,
      ArchitecturePreparedReview
    >(),
    'architecture-review:commits': invoke<
      ArchitectureCommitRangeRequest,
      ArchitectureCommitRange
    >(),
    'architecture-review:close': invoke<ArchitectureReviewKey, void>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
