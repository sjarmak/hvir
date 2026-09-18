import type {
  ComposerSubmitMode,
  HarnessTelemetry,
  HarnessProfileId,
  HarnessLaunchMode,
  HarnessProviderId,
  HarnessProviderCapabilities,
  HostId,
  HostPath,
  TerminalIdentityStatus,
} from '../../shared'
import type { Disposer, ProjectHost, PtyExit } from '../project-host/project-host'
import type {
  HarnessArtifactContext,
  HarnessLaunchSpec,
  HarnessProvider,
} from '../harness/harness-provider-contract'

export interface PtySpawnRequest {
  readonly host: ProjectHost
  readonly provider: HarnessProvider
  /** Precomposed profile launch; tests/legacy callers may omit it. */
  readonly launchSpec?: HarnessLaunchSpec
  readonly unsetEnvironment?: readonly string[]
  readonly artifact?: HarnessArtifactContext
  readonly effectiveCapabilities?: HarnessProviderCapabilities
  /** Exact active profile contract for provider-owned delivery capabilities. */
  readonly profileId?: HarnessProfileId
  readonly launchRevision?: number
  readonly providerContractVersion?: number
  readonly composerSubmitMode?: ComposerSubmitMode
  readonly cwd: HostPath
  /** Mutable presentation/authority owner; launch cwd remains immutable. */
  readonly workspaceRoot?: HostPath
  /** Electron webContents id that owns and may control this PTY. */
  readonly ownerId: number
  /** Main-owned document generation for the renderer attachment. */
  readonly ownerGeneration?: number
  /** hvir's PTY registry id; generated if omitted. */
  readonly sessionId?: string
  /** Exact harness-owned session id, when distinct from the PTY id. */
  readonly harnessSessionId?: string
  /** Resume `harnessSessionId` via the provider rather than launching fresh. */
  readonly resume?: boolean
  /** Provider-neutral launch path. Omitted only by legacy fresh/resume callers. */
  readonly launchMode?: HarnessLaunchMode
  /** Exact provider-owned identity from which a fork is derived. */
  readonly parentHarnessSessionId?: string
  /** Only explicit bulk recovery enters the bounded per-host admission queue. */
  readonly admission?: 'interactive' | 'bulk'
  readonly cols?: number
  readonly rows?: number
  /** Re-probe once when the login-interactive shell reports a missing executable. */
  readonly onClassifiedLaunchFailure?: () => void
}

/** Immutable, serializable description of a managed PTY session. */
export interface ManagedPty {
  /** Unique to this live spawn even when a persisted terminal id is reused. */
  readonly instanceId: string
  readonly id: string
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly hostId: HostId
  readonly cwd: HostPath
  readonly workspaceRoot: HostPath
  readonly providerId: HarnessProviderId
  readonly capabilities: HarnessProviderCapabilities
  readonly profileId?: HarnessProfileId
  readonly launchRevision?: number
  readonly providerContractVersion?: number
  readonly composerSubmitMode?: ComposerSubmitMode
  readonly pid: number
  readonly startedAt: number
  readonly resumed: boolean
  readonly harnessSessionId?: string
  readonly identityStatus: HarnessSessionIdentityStatus
  /** Sticky once provider-owned observation contradicts the registered identity. */
  readonly identityDiverged?: true
}

export interface ObservedManagedPty {
  readonly info: ManagedPty
  readonly telemetry?: HarnessTelemetry
}

export interface PtyObservationSource {
  observationSnapshot(): readonly ObservedManagedPty[]
  observe(listener: () => void): Disposer
}

export type PtyUsageObservationResolution =
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available'
      readonly target: {
        readonly instanceId: string
        readonly providerId: HarnessProviderId
        readonly host: ProjectHost
        readonly sessionId: string
        readonly cwd: HostPath
        readonly sessionData?: unknown
        readonly artifact: HarnessArtifactContext
      }
    }

export interface PtyUsageObservationSource {
  resolveUsageObservation(id: string, instanceId: string): PtyUsageObservationResolution
}

export type HarnessSessionIdentityStatus = TerminalIdentityStatus

export interface PtyStreamHandlers {
  onData?: (data: string) => void
  onExit?: (exit: PtyExit) => void
  onTelemetry?: (telemetry: HarnessTelemetry | undefined) => void
}

/** The desktop's last applied terminal size; a mirror renders at it and never changes it. */
export interface PtyGeometry {
  readonly cols: number
  readonly rows: number
}

export type PtyMirrorEnd =
  | { readonly kind: 'exited'; readonly exit: PtyExit }
  /** The supervisor released the session: revocation, workspace close, or shutdown. */
  | { readonly kind: 'released' }

/** A second reader of one PTY instance (ADR-050). `onEnd` fires exactly once, then nothing. */
export interface PtyMirrorHandlers {
  readonly onData: (data: string) => void
  readonly onGeometry: (geometry: PtyGeometry) => void
  readonly onEnd: (end: PtyMirrorEnd) => void
}

export interface PtyMirrorLease {
  readonly ptyId: string
  readonly instanceId: string
  /** Retained output at attach; live bytes follow through `onData` only. */
  readonly tail: string
  /** Geometry at attach; later changes arrive through `onGeometry`. */
  readonly geometry: PtyGeometry
  readonly ended: boolean
  /** Writes the user's exact bytes to this instance or throws `PtyMirrorRefusedError`. */
  write(data: string): void
  /** Idempotent. Detaches the mirror; never kills, resizes, or transfers the PTY. */
  release(): void
}

export type PtyMirrorRefusal = 'no-session' | 'instance-changed' | 'exited' | 'ended'

export type PtySupervisorDiagnostic =
  | {
      readonly kind: 'pty-spawned' | 'pty-spawn-failed'
      readonly hostKind: 'local' | 'ssh'
      readonly launchMode: HarnessLaunchMode
    }
  | {
      readonly kind: 'pty-exited'
      readonly hostKind: 'local' | 'ssh'
      readonly launchMode: HarnessLaunchMode
      readonly exitKind: 'clean' | 'error' | 'signal'
      readonly lifetime: 'under-30s' | 'under-5m' | '5m-or-more'
    }

export interface PtySupervisorOptions {
  readonly onDiagnostic?: (event: PtySupervisorDiagnostic) => void
  readonly bulkStartConcurrencyPerHost?: number
  readonly registerSessionIdentity?: (
    terminalId: string,
    harnessSessionId: string,
  ) => Promise<boolean>
  readonly cancelSessionIdentityRegistration?: (terminalId: string) => void
}

export type PtyStartUnavailableReason = 'identity-baseline-unavailable'

export class PtyStartUnavailableError extends Error {
  readonly retryable = true

  constructor(
    readonly reason: PtyStartUnavailableReason,
    cause?: unknown,
  ) {
    super('Harness launch identity baseline is unavailable', { cause })
  }
}
