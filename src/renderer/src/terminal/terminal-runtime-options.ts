import { hostPathEquals } from '../../../shared'
import type {
  ComposerSubmitMode,
  HarnessModifiedKeyProtocol,
  HarnessProfileId,
  HarnessProviderCapabilities,
  HarnessTelemetry,
  HostConnectionState,
  HostPath,
  TerminalIdentityStatus,
  ExternalSessionAttachRequest,
  ArchitectureAgentLaunch,
} from '../../../shared'
import type {
  TerminalColorTheme,
  TerminalCursorDefaults,
  TerminalLinkActivation,
  TerminalPresentation,
  TerminalTypography,
} from './terminal-pane'
import type { TerminalForkRequest } from './terminal-workspace-model'

export interface FreshTerminalStart {
  readonly sessionId: string
  readonly status: string
  readonly harnessSessionId?: string
  readonly identityStatus: TerminalIdentityStatus
  readonly capabilities: HarnessProviderCapabilities
}

export interface TerminalRuntimeOptions {
  readonly sessionId: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly supportsResume: boolean
  readonly fallbackTitle: string
  readonly harnessSessionId?: string
  readonly forkRequest?: TerminalForkRequest
  readonly resumeOnStart: boolean
  readonly startMode: 'interactive' | 'bulk'
  /** Command typed into the shell once, right after first launch (e.g. `gc session attach …`). */
  readonly initialInput?: string
  /**
   * The gc session this terminal attaches to, when hvir is performing the
   * attach and the requesting surface could name the session. Declared once, at
   * the launch that performs the attach; main keeps the record afterwards, so a
   * restart names nothing and keeps the join (ADR-046).
   */
  readonly externalAttach?: ExternalSessionAttachRequest
  readonly architectureReview?: ArchitectureAgentLaunch
  readonly position: number
  readonly active: boolean
  readonly presentation: TerminalPresentation
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly composerSubmitMode: ComposerSubmitMode
  readonly theme: TerminalColorTheme
  readonly typography: TerminalTypography
  readonly cursorDefaults: TerminalCursorDefaults
  readonly ligatures: boolean
  readonly cwd: HostPath
  readonly workspaceRoot: HostPath
  readonly connectionState: HostConnectionState
  readonly onTitle: (title: string) => void
  readonly onStatus: (status: string) => void
  readonly onTelemetry: (telemetry: HarnessTelemetry | undefined) => void
  readonly onIdentity: (
    harnessSessionId: string | undefined,
    status: TerminalIdentityStatus,
    identityDiverged?: true,
  ) => void
  readonly onStartFailed?: (reason: string) => void
  readonly onExit?: (exitCode: number) => void
  readonly onStarted: () => void
  readonly onFreshStarted: (started: FreshTerminalStart) => void
  readonly onCapabilities: (capabilities: HarnessProviderCapabilities) => void
  readonly onInput: (data: string) => void
  /** Input a Companion mirror already wrote to this terminal's PTY (ADR-050). */
  readonly onMirrorInput: (data: string) => void
  readonly onOutput: () => void
  readonly onBell: () => void
  /** The program's notification, with its bounded body when it had one (ADR-051). */
  readonly onNotification: (body: string | undefined) => void
  readonly onFocus: () => void
  readonly onLink: (activation: TerminalLinkActivation) => void
}

export function publishTerminalIdentity(
  options: TerminalRuntimeOptions,
  harnessSessionId: string | undefined,
  identityStatus: Parameters<TerminalRuntimeOptions['onIdentity']>[1],
  identityDiverged?: true,
): void {
  if (identityDiverged) options.onIdentity(harnessSessionId, identityStatus, true)
  else options.onIdentity(harnessSessionId, identityStatus)
}

export function assertTerminalLaunchContext(
  current: TerminalRuntimeOptions,
  next: TerminalRuntimeOptions,
): void {
  if (
    next.profileId !== current.profileId ||
    next.launchRevision !== current.launchRevision ||
    !hostPathEquals(next.cwd, current.cwd)
  ) {
    throw new Error('Live terminal launch context cannot change')
  }
}
