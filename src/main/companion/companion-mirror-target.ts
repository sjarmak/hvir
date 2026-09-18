/**
 * Which row a Companion page may mirror, and what to attach to (ADR-050).
 *
 * Pure. Eligibility is exactly the desktop's Interact gate: a live lifecycle,
 * a connected host, and a live PTY. The target is the identity the projection
 * already carries: the row handle is the PTY id and the live qualifier's
 * handle is the PTY instance id. Both are plain casts, never decoded, and
 * neither reaches a page.
 */
import type {
  SessionsObservationSnapshot,
  SessionsObservedSession,
  SessionsTerminalHandle,
  SessionsWorkspaceProjection,
} from '../../shared'

export interface CompanionMirrorTarget {
  readonly ptyId: string
  readonly instanceId: string
}

export function companionMirrorEligible(
  session: SessionsObservedSession,
  workspace: SessionsWorkspaceProjection,
): boolean {
  return (
    session.lifecycle === 'live' &&
    session.livePty !== undefined &&
    workspace.host.connectionState === 'connected' &&
    !workspace.closed &&
    !workspace.missing
  )
}

export function companionMirrorTarget(
  observation: Pick<SessionsObservationSnapshot, 'sessions' | 'workspaces'>,
  handle: SessionsTerminalHandle,
): CompanionMirrorTarget | undefined {
  const session = observation.sessions.find((candidate) => candidate.handle === handle)
  if (session?.livePty === undefined) return undefined
  const workspace = observation.workspaces.find(
    (candidate) => candidate.workspaceId === session.workspaceId,
  )
  if (workspace === undefined || !companionMirrorEligible(session, workspace)) {
    return undefined
  }
  return { ptyId: String(session.handle), instanceId: String(session.livePty.handle) }
}
