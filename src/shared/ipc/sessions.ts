import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type SessionsDemandRequest,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
  type SessionsObservationSnapshot,
  type SessionsProjectionChange,
  type SessionsTerminalResolutionResponse,
  type SessionsUsageChange,
  type SessionsUsageDemandRequest,
  type SessionsUsageSnapshot,
} from '../sessions-projection'
import {
  type SessionsAttachExternalRequest,
  type SessionsAttachExternalResponse,
  type SessionsTranscriptChange,
  type SessionsTranscriptRequest,
  type SessionsTranscriptSnapshot,
} from '../sessions-transcript'

export const sessionsIpc = {
  invoke: {
    'sessions:observe': invoke<SessionsDemandRequest, SessionsObservationSnapshot>(),
    'sessions:snapshot': invoke<SessionsDemandRequest, SessionsObservationSnapshot>(),
    'sessions:release': invoke<SessionsDemandRequest, void>(),
    'sessions:usage-observe': invoke<SessionsUsageDemandRequest, SessionsUsageSnapshot>(),
    'sessions:usage-snapshot': invoke<SessionsDemandRequest, SessionsUsageSnapshot>(),
    'sessions:usage-release': invoke<SessionsDemandRequest, void>(),
    'sessions:open': invoke<SessionsOpenRequest, SessionsOpenResponse>(),
    'sessions:resolve-terminal': invoke<
      SessionsOpenRequest,
      SessionsTerminalResolutionResponse
    >(),
    'sessions:transcript-observe': invoke<
      SessionsTranscriptRequest,
      SessionsTranscriptSnapshot
    >(),
    'sessions:transcript-snapshot': invoke<
      SessionsDemandRequest,
      SessionsTranscriptSnapshot
    >(),
    /** Reopens a dropped stream. Explicit, because nothing reconnects for it. */
    'sessions:transcript-resume': invoke<
      SessionsDemandRequest,
      SessionsTranscriptSnapshot
    >(),
    'sessions:transcript-release': invoke<SessionsDemandRequest, void>(),
    /**
     * The escape hatch for a row hvir owns no terminal for. The answer carries
     * the command to run and a ticket that stands for the session, never the
     * session's own identifier (ADR-046).
     */
    'sessions:attach-external': invoke<
      SessionsAttachExternalRequest,
      SessionsAttachExternalResponse
    >(),
  },
  send: {},
  event: {
    'sessions:changed': payload<SessionsProjectionChange>(),
    'sessions:usage-changed': payload<SessionsUsageChange>(),
    'sessions:transcript-changed': payload<SessionsTranscriptChange>(),
  },
} satisfies IpcFeatureContract
