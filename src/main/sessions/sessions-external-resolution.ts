/**
 * Exact resolution from a projected row to the foreign session behind it.
 *
 * Two callers need it and neither may hold the identifier. A transcript pane
 * asks what session the selected row stands for, so main can read it. An attach
 * asks the same question and also where the terminal would land, so the command
 * runs in the row's own workspace. Both answers are checked against the
 * projection the renderer was looking at (ADR-046: exact knowledge, never
 * inference), and both are refused once it has moved on.
 */
import type {
  SessionsAttachExternalRequest,
  SessionsAttachExternalUnavailableReason,
  SessionsObservationSnapshot,
  SessionsObservedSession,
  SessionsTerminalHandle,
  SessionsTranscriptRequest,
} from '../../shared'
import {
  resolveSessionsPlacement,
  type SessionsResolvedPlacement,
} from './sessions-open-resolution'
import type {
  SessionsExternalSessionTarget,
  SessionsProjectionIdentityScope,
} from './sessions-projection-identities'

type ObservationBase = Omit<SessionsObservationSnapshot, 'demandGeneration' | 'revision'>

/** Why a row cannot be read as an external session. */
export type SessionsExternalResolutionReason = 'not-projected' | 'stale-projection'

export type SessionsResolvedExternalSession =
  | {
      readonly outcome: 'resolved'
      readonly target: SessionsExternalSessionTarget
      /**
       * hvir owns the terminal for this row right now, so a borrowed surface
       * exists and the transcript is the alternative view rather than the only
       * one.
       */
      readonly live: boolean
    }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsExternalResolutionReason
    }

export type SessionsResolvedExternalAttach =
  | {
      readonly outcome: 'resolved'
      readonly projectId: string
      readonly workspaceId: string
      readonly handle: SessionsTerminalHandle
      readonly target: SessionsExternalSessionTarget
      /** How the source addresses the session in a command. */
      readonly attachTarget: string
    }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsAttachExternalUnavailableReason
    }

export function resolveSessionsExternalSession({
  request,
  activeDemandGeneration,
  sourceRevision,
  observation,
  identities,
}: {
  readonly request: Pick<
    SessionsTranscriptRequest,
    'handle' | 'projectionDemandGeneration' | 'sourceRevision'
  >
  readonly activeDemandGeneration?: number
  readonly sourceRevision: number
  readonly observation?: ObservationBase
  readonly identities?: SessionsProjectionIdentityScope
}): SessionsResolvedExternalSession {
  if (
    activeDemandGeneration !== request.projectionDemandGeneration ||
    request.sourceRevision !== sourceRevision ||
    !observation ||
    !identities
  ) {
    return { outcome: 'unavailable', reason: 'stale-projection' }
  }
  return currentSessionsExternalSession(request.handle, observation, identities)
}

/**
 * The same resolution without the revision check, for a subscription that
 * already exists. A held stream is reconciled against the projection as it
 * moves, and a revision bump is the normal case there, not a refusal: what
 * matters is whether the handle still stands for the same session.
 */
export function currentSessionsExternalSession(
  handle: SessionsTerminalHandle,
  observation: ObservationBase | undefined,
  identities: SessionsProjectionIdentityScope | undefined,
): SessionsResolvedExternalSession {
  if (!observation || !identities) {
    return { outcome: 'unavailable', reason: 'stale-projection' }
  }
  const observed = observation.sessions.find((session) => session.handle === handle)
  const target = identities.resolveExternalSession(handle)
  // A handle with no recorded session is not an external row, whether it is
  // one of hvir's own or a row that has since left the projection. Either way
  // there is nothing exact to read.
  if (!observed || !target) return { outcome: 'unavailable', reason: 'not-projected' }
  return { outcome: 'resolved', target, live: isLive(observed) }
}

export function resolveSessionsExternalAttach({
  request,
  activeDemandGeneration,
  sourceRevision,
  observation,
  identities,
  projectState,
}: {
  readonly request: SessionsAttachExternalRequest
  readonly activeDemandGeneration?: number
  readonly sourceRevision: number
  readonly observation?: ObservationBase
  readonly identities?: SessionsProjectionIdentityScope
  readonly projectState: Parameters<typeof resolveSessionsPlacement>[0]['projectState']
}): SessionsResolvedExternalAttach {
  if (
    activeDemandGeneration !== request.demandGeneration ||
    request.sourceRevision !== sourceRevision ||
    !observation ||
    !identities
  ) {
    return { outcome: 'unavailable', reason: 'stale-projection' }
  }
  const placed = resolveSessionsPlacement({
    request,
    observation,
    identities,
    projectState,
  })
  if (placed.outcome === 'unavailable')
    return { outcome: 'unavailable', reason: attachReason(placed) }
  const target = identities.resolveExternalSession(request.handle)
  // An attach runs a command the source published for the session. Without
  // that alias there is nothing to run, and the identifier is not a substitute:
  // it is not a documented command argument.
  if (target?.attachTarget === undefined) {
    return { outcome: 'unavailable', reason: 'not-projected' }
  }
  return {
    outcome: 'resolved',
    projectId: placed.projectId,
    workspaceId: placed.workspaceId,
    handle: request.handle,
    target,
    attachTarget: target.attachTarget,
  }
}

/**
 * An attach needs no live terminal, so a row whose session hvir is not running
 * is not "session unavailable" to it; it is a row this projection cannot place.
 */
function attachReason(
  placed: Extract<SessionsResolvedPlacement, { outcome: 'unavailable' }>,
): SessionsAttachExternalUnavailableReason {
  return placed.reason === 'session-unavailable' ? 'not-projected' : placed.reason
}

function isLive(observed: SessionsObservedSession): boolean {
  return observed.lifecycle === 'live' && observed.livePty !== undefined
}
