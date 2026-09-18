import type { HostConnectionState } from './fs-types'
import type { HarnessProfileId } from './harness-profile'
import type { HarnessContextPressurePolicy, HarnessProviderId } from './harness-provider'
import type { HarnessUsageValue } from './harness-usage'
import type { ProjectState } from './workspace-types'

export const SESSIONS_PROJECTION_VERSION = 1
export const MAX_SESSIONS_PROJECTION_ROWS = 500
export const MAX_SESSIONS_PROJECTION_WORKSPACES = 1_000
export const MAX_SESSIONS_PROJECTION_PROVIDERS = 128
export const MAX_SESSIONS_USAGE_ROWS = MAX_SESSIONS_PROJECTION_ROWS

declare const sessionsTerminalHandleBrand: unique symbol
declare const sessionsPtyHandleBrand: unique symbol
declare const sessionsProjectHandleBrand: unique symbol
declare const sessionsWorkspaceHandleBrand: unique symbol
declare const sessionsWorkspaceQualifierBrand: unique symbol
declare const sessionsWorkspaceRuntimeIdBrand: unique symbol

/** Opaque hvir identity. Consumers may compare or route it, but never present it. */
export type SessionsTerminalHandle = string & {
  readonly [sessionsTerminalHandleBrand]: 'SessionsTerminalHandle'
}

/** Opaque identity for one exact live PTY instance. */
export type SessionsPtyHandle = string & {
  readonly [sessionsPtyHandleBrand]: 'SessionsPtyHandle'
}

/** Projection-owned identity with no host or path content. */
export type SessionsProjectHandle = string & {
  readonly [sessionsProjectHandleBrand]: 'SessionsProjectHandle'
}

/** Projection-owned identity with no host or path content. */
export type SessionsWorkspaceHandle = string & {
  readonly [sessionsWorkspaceHandleBrand]: 'SessionsWorkspaceHandle'
}

/** Path-free qualifier for matching one ProjectState workspace revision in the renderer. */
export type SessionsWorkspaceQualifier = string & {
  readonly [sessionsWorkspaceQualifierBrand]: 'SessionsWorkspaceQualifier'
}

/** Renderer workspace owner selected by main; never present this internal routing value. */
export type SessionsWorkspaceRuntimeId = string & {
  readonly [sessionsWorkspaceRuntimeIdBrand]: 'SessionsWorkspaceRuntimeId'
}

/**
 * Foreign authorities Sessions may project a session from. Declared here, not
 * discovered: ADR-046 enumerates the sources rather than letting a transport
 * that happens to answer widen the view.
 */
export type SessionsExternalSourceId = 'gas-city'

/**
 * Which authority owns the session a row describes.
 *
 * Structured on purpose. A consumer must be able to tell an external agent
 * session from an hvir terminal without reading a title, and projection code
 * branches on this and on declared capability rather than on a provider name
 * (ADR-046).
 */
export type SessionsOrigin =
  | { readonly kind: 'hvir-terminal' }
  | {
      readonly kind: 'external-agent'
      readonly sourceId: SessionsExternalSourceId
      /** Display name of the owning authority; never an identifier of its own. */
      readonly sourceName: string
    }

/** The origin of every session hvir launched itself. */
export const SESSIONS_HVIR_ORIGIN: SessionsOrigin = { kind: 'hvir-terminal' }

export type SessionsReasonCode =
  | 'not-materialized'
  | 'not-live'
  | 'telemetry-pending'
  | 'source-unavailable'
  | 'source-stale'
  | 'connection-unavailable'
  | 'workspace-unavailable'
  | 'stopped'
  | 'recovery-unavailable'
  | 'transport-unavailable'

export type SessionsUsageReasonCode =
  | 'not-live'
  | 'identity-pending'
  | 'observation-pending'
  | 'identity-unavailable'
  | 'connection-unavailable'
  | 'source-unavailable'
  | 'observation-capacity'

/** Content-free cumulative usage projected from the provider-owned observer. */
export type SessionsUsageFact =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending'; readonly reason: SessionsUsageReasonCode }
  | { readonly status: 'unavailable'; readonly reason: SessionsUsageReasonCode }
  | { readonly status: 'reset'; readonly reason: SessionsUsageReasonCode }
  | {
      readonly status: 'stale'
      readonly value: HarnessUsageValue
      readonly observedAt: number
      readonly reason: SessionsUsageReasonCode
    }
  | {
      readonly status: 'exact' | 'partial'
      readonly value: HarnessUsageValue
      readonly observedAt: number
    }

export type SessionsFact<T> =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending'; readonly reason: SessionsReasonCode }
  | { readonly status: 'unavailable'; readonly reason: SessionsReasonCode }
  | {
      readonly status: 'stale'
      readonly value: T
      readonly observedAt: number
      readonly reason: SessionsReasonCode
    }
  | { readonly status: 'available'; readonly value: T; readonly observedAt?: number }

export interface SessionsModelFact {
  readonly id: string
  readonly displayName?: string
}

export interface SessionsContextFact {
  /**
   * Absent when the source reports only a percentage. Some sources know how
   * full a context is without knowing how many tokens that is, and a count
   * assumed from a percentage would be a fact hvir invented.
   */
  readonly usedTokens?: number
  readonly windowTokens?: number
  readonly usedPercent?: number
}

/**
 * Whether a row is asking for a person. `ready` is work that finished and has
 * not been looked at; `bell` is a terminal that rang; `prompt` is a terminal
 * whose program notified, with a message the row carries beside it (ADR-051).
 */
export type SessionsAttentionValue = 'none' | 'ready' | 'bell' | 'prompt'

export interface SessionsTurnFact {
  readonly state: 'working' | 'waiting-for-user' | 'waiting-for-approval' | 'idle'
}

export interface SessionsFreshnessFact {
  readonly staleAfterMs: number
}

export interface SessionsTelemetryFacts {
  readonly model: SessionsFact<SessionsModelFact>
  readonly context: SessionsFact<SessionsContextFact>
  readonly turn: SessionsFact<SessionsTurnFact>
  readonly freshness: SessionsFact<SessionsFreshnessFact>
}

export interface SessionsProviderProjection {
  readonly id: HarnessProviderId
  readonly displayName: string
  readonly telemetrySupported: boolean
  readonly usageSupported: boolean
  readonly sessionKind: 'agent' | 'shell'
  readonly contextPressure?: HarnessContextPressurePolicy
}

export interface SessionsWorkspaceProjection {
  readonly projectId: SessionsProjectHandle
  readonly projectName: string
  readonly workspaceId: SessionsWorkspaceHandle
  readonly qualifier: SessionsWorkspaceQualifier
  readonly workspaceName: string
  readonly main: boolean
  readonly closed: boolean
  readonly missing: boolean
  readonly host: {
    readonly id: string
    readonly label: string
    readonly kind: 'local' | 'ssh'
    readonly connectionState: HostConnectionState
  }
}

export interface SessionsLivePtyQualifier {
  readonly handle: SessionsPtyHandle
  readonly rendererOwnerId: number
  readonly rendererGeneration: number
}

/** Main-safe facts before renderer runtime/attention state is joined. */
export interface SessionsObservedSession {
  readonly handle: SessionsTerminalHandle
  readonly workspaceId: SessionsWorkspaceHandle
  readonly origin: SessionsOrigin
  readonly providerId: HarnessProviderId
  readonly profile: SessionsFact<{ readonly id: HarnessProfileId }>
  readonly title: string
  readonly lifecycle: 'retained' | 'live'
  readonly livePty?: SessionsLivePtyQualifier
  readonly telemetry: SessionsTelemetryFacts
  /**
   * Attention the source itself declared, for a row hvir runs no terminal for.
   * Absent for hvir's own sessions, whose attention is the renderer's to state:
   * a terminal's unseen output is known where it is rendered (ADR-009). Present
   * only where the signal is exact, never inferred (ADR-048).
   */
  readonly attention?: SessionsFact<SessionsAttentionValue>
}

export interface SessionsObservationSnapshot {
  readonly version: typeof SESSIONS_PROJECTION_VERSION
  readonly demandGeneration: number
  readonly revision: number
  readonly activeProject?: SessionsProjectHandle
  readonly workspaces: readonly SessionsWorkspaceProjection[]
  readonly providers: readonly SessionsProviderProjection[]
  readonly sessions: readonly SessionsObservedSession[]
}

export interface SessionsProjectionChange {
  readonly demandGeneration: number
  readonly revision: number
}

export interface SessionsDemandRequest {
  readonly demandGeneration: number
}

export interface SessionsUsageDemandTarget {
  readonly handle: SessionsTerminalHandle
  readonly livePty?: SessionsLivePtyQualifier
}

export interface SessionsUsageDemandRequest {
  readonly demandGeneration: number
  readonly projectionDemandGeneration: number
  readonly sourceRevision: number
  readonly targets: readonly SessionsUsageDemandTarget[]
}

export interface SessionsUsageSnapshotRow {
  readonly handle: SessionsTerminalHandle
  readonly usage: SessionsUsageFact
}

export interface SessionsUsageSnapshot {
  readonly version: typeof SESSIONS_PROJECTION_VERSION
  readonly demandGeneration: number
  readonly revision: number
  readonly sampledAt: number
  readonly rows: readonly SessionsUsageSnapshotRow[]
}

export interface SessionsUsageChange {
  readonly demandGeneration: number
  readonly revision: number
}

export interface SessionsOpenRequest extends SessionsDemandRequest {
  readonly sourceRevision: number
  readonly handle: SessionsTerminalHandle
  readonly projectId: SessionsProjectHandle
  readonly workspaceId: SessionsWorkspaceHandle
  readonly workspaceQualifier: SessionsWorkspaceQualifier
  readonly livePty?: SessionsLivePtyQualifier
}

export type SessionsOpenUnavailableReason =
  | 'stale-projection'
  | 'session-unavailable'
  | 'workspace-unavailable'
  | 'connection-unavailable'
  | 'terminal-unavailable'

export type SessionsOpenResponse =
  | {
      readonly outcome: 'opened'
      readonly state: ProjectState
      readonly handle: SessionsTerminalHandle
      readonly workspaceQualifier: SessionsWorkspaceQualifier
      readonly livePty: SessionsLivePtyQualifier
    }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsOpenUnavailableReason
    }

/** A retained (non-live) session, addressed the same opaque way as an open request. */
export interface SessionsMutationRequest extends SessionsDemandRequest {
  readonly sourceRevision: number
  readonly handle: SessionsTerminalHandle
  readonly projectId: SessionsProjectHandle
  readonly workspaceId: SessionsWorkspaceHandle
  readonly workspaceQualifier: SessionsWorkspaceQualifier
}

export interface SessionsRenameRequest extends SessionsMutationRequest {
  readonly title: string
}

export type SessionsProjectionMutationResponse =
  | { readonly outcome: 'applied' }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsOpenUnavailableReason
    }

/** Exact read-only resolution for borrowing an existing renderer terminal surface. */
export type SessionsTerminalResolutionResponse =
  | {
      readonly outcome: 'resolved'
      readonly handle: SessionsTerminalHandle
      readonly workspaceQualifier: SessionsWorkspaceQualifier
      readonly workspaceRuntimeId: SessionsWorkspaceRuntimeId
      readonly livePty: SessionsLivePtyQualifier
    }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsOpenUnavailableReason
    }

export type SessionsLifecycle =
  'retained' | 'starting' | 'resuming' | 'live' | 'stopped' | 'unavailable'

export interface SessionsProjectionRow {
  readonly handle: SessionsTerminalHandle
  readonly origin: SessionsOrigin
  readonly project: { readonly id: SessionsProjectHandle; readonly name: string }
  readonly workspace: {
    readonly id: SessionsWorkspaceHandle
    readonly name: string
    readonly main: boolean
    readonly qualifier: SessionsWorkspaceQualifier
  }
  readonly host: SessionsWorkspaceProjection['host']
  readonly provider: {
    readonly id: HarnessProviderId
    readonly name: string
    readonly kind: 'agent' | 'shell' | 'unknown'
    readonly contextPressure?: HarnessContextPressurePolicy
  }
  readonly profile: SessionsFact<{ readonly id: HarnessProfileId }>
  readonly title: string
  readonly lifecycle: SessionsLifecycle
  readonly lifecycleReason?: SessionsReasonCode
  readonly connectionState: HostConnectionState
  readonly attention: SessionsFact<SessionsAttentionValue>
  /** The notification's message, bounded; present only with a `prompt` attention. */
  readonly promptBody?: string
  readonly working: SessionsFact<boolean>
  readonly model: SessionsFact<SessionsModelFact>
  readonly context: SessionsFact<SessionsContextFact>
  readonly turn: SessionsFact<SessionsTurnFact>
  readonly telemetryFreshness: SessionsFact<SessionsFreshnessFact>
  /** Capability baseline; the active Usage lens overlays demanded observations. */
  readonly usage: SessionsUsageFact
  readonly livePty?: SessionsLivePtyQualifier
}

export interface SessionsProjectionSnapshot {
  readonly version: typeof SESSIONS_PROJECTION_VERSION
  readonly demandGeneration: number
  readonly revision: number
  /** Main-owned observation revision used only for exact actions. */
  readonly sourceRevision: number
  readonly activeProject?: SessionsProjectHandle
  readonly status: 'inactive' | 'pending' | 'available' | 'unavailable'
  readonly unavailableReason?: 'source-unavailable'
  readonly rows: readonly SessionsProjectionRow[]
}

export function asSessionsTerminalHandle(value: string): SessionsTerminalHandle {
  return value as SessionsTerminalHandle
}

export function asSessionsPtyHandle(value: string): SessionsPtyHandle {
  return value as SessionsPtyHandle
}

export function asSessionsProjectHandle(value: string): SessionsProjectHandle {
  return value as SessionsProjectHandle
}

export function asSessionsWorkspaceHandle(value: string): SessionsWorkspaceHandle {
  return value as SessionsWorkspaceHandle
}

export function asSessionsWorkspaceRuntimeId(value: string): SessionsWorkspaceRuntimeId {
  return value as SessionsWorkspaceRuntimeId
}

export function sessionsWorkspaceQualifier(
  projectStateRevision: number,
  projectIndex: number,
  workspaceIndex: number,
): SessionsWorkspaceQualifier {
  if (
    !Number.isSafeInteger(projectStateRevision) ||
    projectStateRevision < 0 ||
    !Number.isSafeInteger(projectIndex) ||
    projectIndex < 0 ||
    !Number.isSafeInteger(workspaceIndex) ||
    workspaceIndex < 0
  ) {
    throw new Error('Invalid Sessions workspace qualifier')
  }
  return `${projectStateRevision}:${projectIndex}:${workspaceIndex}` as SessionsWorkspaceQualifier
}

export function sessionsProjectionText(
  value: string | undefined,
  max: number,
  fallback: string,
): string {
  return sessionsProjectionOptionalText(value, max) ?? fallback
}

export function sessionsProjectionOptionalText(
  value: string | undefined,
  max: number,
): string | undefined {
  if (typeof value !== 'string' || !Number.isSafeInteger(max) || max <= 0) {
    return undefined
  }
  const clean = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, max)
  return clean || undefined
}

export function sessionsProjectionTitle(value: string | undefined): string {
  return sessionsProjectionText(value, 512, 'Terminal')
}

/** Keeps exact private routing and path values from crossing a display boundary. */
export function sessionsProjectionDisplayTitle(
  value: string | undefined,
  handle: SessionsTerminalHandle,
  fallback: string,
  exactPrivateValues: readonly string[] = [],
): string {
  const title = sessionsProjectionTitle(value)
  const privateValues = [String(handle), ...exactPrivateValues].filter(
    (privateValue) => privateValue.length > 0,
  )
  if (!containsExactPrivateValue(value, title, privateValues)) return title
  const safeFallback = sessionsProjectionTitle(fallback)
  if (!containsExactPrivateValue(fallback, safeFallback, privateValues)) {
    return safeFallback
  }
  return 'Terminal'
}

function containsExactPrivateValue(
  rawValue: string | undefined,
  projectedValue: string,
  privateValues: readonly string[],
): boolean {
  return privateValues.some(
    (privateValue) =>
      rawValue?.includes(privateValue) === true || projectedValue.includes(privateValue),
  )
}
