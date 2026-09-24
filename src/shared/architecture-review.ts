import type { HostPath } from './host-path'

export type ArchitectureComparisonMode =
  'working-tree' | 'head' | 'branch-point' | 'commit'
export interface ArchitectureCaptureRequest {
  readonly root: HostPath
  readonly mode: ArchitectureComparisonMode
  /** Full or abbreviated commit hash; used only by the explicit commit comparison. */
  readonly revision?: string
}
export interface ArchitectureSource {
  /** Repository-relative identifier; resolve only against the snapshot's qualified root. */
  readonly path: string
  readonly content: string
  /** Git's blob id for exactly `content`, from the object store or hashed on the host. */
  readonly object: string
}
export interface ArchitectureCapture {
  readonly root: HostPath
  readonly mode: ArchitectureComparisonMode
  readonly baselineRevision: string
  readonly currentRevision: string
  readonly fingerprint: string
  readonly before: readonly ArchitectureSource[]
  readonly after: readonly ArchitectureSource[]
  /** tsconfig, jsconfig and package.json files each end resolves imports with. */
  readonly configs: {
    readonly before: readonly ArchitectureSource[]
    readonly after: readonly ArchitectureSource[]
  }
  readonly exclusions: readonly string[]
  readonly capturedAt: string
}
export const ARCHITECTURE_SCOPE = {
  maxFiles: 4_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxListingBytes: 2 * 1024 * 1024,
  excludedDirectories: [
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    'coverage',
    'vendor',
  ],
  extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
} as const

export interface ArchitectureReviewKey {
  readonly root: HostPath
  readonly reviewId: string
}
export interface ArchitectureReviewRequest
  extends ArchitectureCaptureRequest, ArchitectureReviewKey {}
export interface ArchitectureReviewSnapshot extends Omit<
  ArchitectureCapture,
  'before' | 'after' | 'configs'
> {
  readonly id: string
  readonly analysis: import('./architecture-analysis').ArchitectureAnalysis
  readonly metrics: import('./architecture-scan-metrics').ArchitectureScanMetrics
}
export interface ArchitectureEvidenceRequest extends ArchitectureReviewKey {
  readonly snapshotId: string
  readonly path: HostPath
  /** Read pinned bytes without the freshness check; launch preparation always checks. */
  readonly capturedOnly?: boolean
}
export interface ArchitectureEvidence {
  readonly snapshotId: string
  /** null until freshness is checked; actions must require false. */
  readonly stale: boolean | null
  readonly diff: import('./viewer-types').GitDiffResponse
}

export interface ArchitectureReviewLaunch extends ArchitectureEvidenceRequest {
  readonly digest: string
}
export interface ArchitecturePreparedReview extends ArchitectureReviewLaunch {
  readonly body: string
}
