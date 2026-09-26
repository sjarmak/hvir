import type { HostPath } from './host-path'
import type { ArchitectureLayout } from './architecture-layout'

/**
 * The two ends of a snapshot (ADR-063). Either end may be any commit a ref names (branch,
 * tag, HEAD~n, hash); only Current may be the live working tree.
 */
export interface ArchitectureCaptureRequest {
  readonly root: HostPath
  /** A commit ref; omitted means the branch point of Current with the default branch. */
  readonly baseline?: string
  /** A commit ref; omitted means the live working tree. */
  readonly current?: string
}
/** Labels a snapshot end carries when the request left it at its default. */
export const ARCHITECTURE_BRANCH_POINT = 'branch point'
export const ARCHITECTURE_WORKING_TREE = 'working tree'
/** The `currentRevision` of a snapshot whose Current end is the live tree. */
export const ARCHITECTURE_LIVE_REVISION = 'working-tree'
const MAX_REF_LENGTH = 256

/**
 * Why a ref cannot name a snapshot end, or undefined when Git may resolve it. A leading
 * dash would be read as an option, so it is refused before any Git command runs.
 */
export function architectureRefProblem(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0) return 'Enter a ref'
  if (ref.length > MAX_REF_LENGTH) return 'Ref is too long'
  if (ref.startsWith('-')) return 'A ref cannot start with "-"'
  if (/[\s\p{Cc}]/u.test(ref)) return 'A ref cannot contain spaces or control characters'
  return undefined
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
  /** The Baseline ref as requested, or the branch-point label. */
  readonly baselineRef: string
  /** The Current ref as requested, or the working-tree label. */
  readonly currentRef: string
  readonly baselineRevision: string
  /** The Current commit, or ARCHITECTURE_LIVE_REVISION when Current is the live tree. */
  readonly currentRevision: string
  readonly fingerprint: string
  readonly before: readonly ArchitectureSource[]
  readonly after: readonly ArchitectureSource[]
  /**
   * tsconfig, jsconfig, package.json, go.mod and Cargo.toml files each end resolves
   * imports with.
   */
  readonly configs: {
    readonly before: readonly ArchitectureSource[]
    readonly after: readonly ArchitectureSource[]
  }
  readonly exclusions: readonly string[]
  /** Subsystem mapping and scope, from the Current end's layout file or the defaults. */
  readonly layout: ArchitectureLayout
  readonly capturedAt: string
}
export const ARCHITECTURE_SCOPE = {
  maxFiles: 4_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxListingBytes: 16 * 1024 * 1024,
  excludedDirectories: [
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    'coverage',
    'vendor',
    '__pycache__',
    '.venv',
    'venv',
    'site-packages',
    '.tox',
    '.nox',
    '.mypy_cache',
    '.pytest_cache',
  ],
  extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs'],
} as const

export interface ArchitectureReviewKey {
  readonly root: HostPath
  readonly reviewId: string
}
export type ArchitectureReviewChanged = ArchitectureReviewKey
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
  /** The agent's prompt, which points at the brief. */
  readonly body: string
  readonly handoff: import('./architecture-handoff').ArchitectureHandoffPlan
}

/** A commit on the strip, with the first parent pairwise stepping compares it to. */
export interface ArchitectureCommit {
  readonly revision: string
  readonly parent: string | null
  readonly subject: string
}
export interface ArchitectureCommitRangeRequest {
  readonly root: HostPath
  /** Widens the strip back to this ref; omitted means the default branch. */
  readonly from?: string
}
/** First-parent commits from `base` (exclusive) to HEAD, oldest first. */
export interface ArchitectureCommitRange {
  readonly base: ArchitectureCommit
  readonly commits: readonly ArchitectureCommit[]
  /** True when older commits in the range were left off the strip. */
  readonly truncated: boolean
}
export const ARCHITECTURE_COMMIT_STRIP_LIMIT = 200
