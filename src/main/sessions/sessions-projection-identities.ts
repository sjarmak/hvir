import {
  MAX_SESSIONS_PROJECTION_ROWS,
  type HostId,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  type HostPath,
  type SessionsExternalSourceId,
  type SessionsProjectHandle,
  type SessionsTerminalHandle,
  type SessionsWorkspaceHandle,
} from '../../shared'

/** The foreign identifier behind one projected external session. */
export interface SessionsExternalSessionKey {
  readonly sourceId: SessionsExternalSourceId
  /**
   * The host the source was read on. Part of the identity, not context: two
   * hosts run two supervisors, and one identifier can name a session on each.
   */
  readonly hostId: HostId
  /** Identifier in the foreign source's namespace; never leaves main. */
  readonly key: string
}

/** What a projected external row stands for, for the code that may read it. */
export interface SessionsExternalSessionTarget extends SessionsExternalSessionKey {
  /** The city root the session's host reported, when a marker resolved one. */
  readonly cityRoot?: HostPath
  /** How the source addresses this session in a command, when it says. */
  readonly attachTarget?: string
}

/**
 * How many external sessions one demand may mint handles for.
 *
 * The map lives as long as the demand, and a foreign source can churn
 * identifiers without hvir noticing, so minting is capped rather than trusted
 * to stay near the row bound. Twice the row bound leaves room for normal
 * turnover; past that the projection drops sessions it cannot name, which is
 * visible, instead of growing a map nothing evicts.
 */
const MAX_EXTERNAL_SESSION_HANDLES = MAX_SESSIONS_PROJECTION_ROWS * 2

export interface SessionsProjectionIdentityScope {
  project(root: HostPath): SessionsProjectHandle
  workspace(root: HostPath): SessionsWorkspaceHandle
  /**
   * One opaque handle per foreign session identifier. Absent once this demand
   * has minted {@link MAX_EXTERNAL_SESSION_HANDLES}, so a caller drops the
   * session rather than presenting an identifier it cannot mint a handle for.
   */
  externalSession(target: SessionsExternalSessionTarget): SessionsTerminalHandle | undefined
  /**
   * Record that a handle hvir already minted for its own terminal also stands
   * for a foreign session, because that terminal is attached to it. The row's
   * identity stays hvir's; what it presents, and what a detail pane may read,
   * is the session.
   */
  bindExternalSession(
    handle: SessionsTerminalHandle,
    target: SessionsExternalSessionTarget,
  ): void
  /** The foreign session a projected handle stands for. Main only. */
  resolveExternalSession(
    handle: SessionsTerminalHandle,
  ): SessionsExternalSessionTarget | undefined
  resolveProject(handle: SessionsProjectHandle): HostPath | undefined
  resolveWorkspace(handle: SessionsWorkspaceHandle): HostPath | undefined
  clear(): void
}

/** Demand-lifetime opaque identities; source host/path values never cross the projection. */
export function createSessionsProjectionIdentityScope(): SessionsProjectionIdentityScope {
  const projects = new Map<string, SessionsProjectHandle>()
  const workspaces = new Map<string, SessionsWorkspaceHandle>()
  const projectRoots = new Map<SessionsProjectHandle, HostPath>()
  const workspaceRoots = new Map<SessionsWorkspaceHandle, HostPath>()
  const externalSessions = new Map<string, SessionsTerminalHandle>()
  const externalTargets = new Map<SessionsTerminalHandle, SessionsExternalSessionTarget>()
  let nextProject = 0
  let nextWorkspace = 0
  let nextExternalSession = 0

  return {
    project: (root) => {
      const key = sessionsProjectionRootKey(root.hostId, root.path)
      const current = projects.get(key)
      if (current) return current
      const created = asSessionsProjectHandle(`sessions-project-${(nextProject += 1)}`)
      projects.set(key, created)
      projectRoots.set(created, root)
      return created
    },
    workspace: (root) => {
      const key = sessionsProjectionRootKey(root.hostId, root.path)
      const current = workspaces.get(key)
      if (current) return current
      const created = asSessionsWorkspaceHandle(
        `sessions-workspace-${(nextWorkspace += 1)}`,
      )
      workspaces.set(key, created)
      workspaceRoots.set(created, root)
      return created
    },
    externalSession: (target) => {
      const mapKey = externalSessionKey(target)
      const current = externalSessions.get(mapKey)
      if (current) {
        externalTargets.set(current, target)
        return current
      }
      if (externalSessions.size >= MAX_EXTERNAL_SESSION_HANDLES) return undefined
      // Zero padded so the handle's lexicographic order is its minting order:
      // the projection's final tiebreak is the handle string, and minting
      // follows the source's own ordering.
      const created = asSessionsTerminalHandle(
        `sessions-external-${String((nextExternalSession += 1)).padStart(4, '0')}`,
      )
      externalSessions.set(mapKey, created)
      externalTargets.set(created, target)
      return created
    },
    bindExternalSession: (handle, target) => {
      // Bounded with the minted handles: a foreign source that churns
      // identifiers must not grow a map nothing evicts.
      if (
        !externalTargets.has(handle) &&
        externalTargets.size >= MAX_EXTERNAL_SESSION_HANDLES
      )
        return
      externalTargets.set(handle, target)
    },
    resolveExternalSession: (handle) => externalTargets.get(handle),
    resolveProject: (handle) => projectRoots.get(handle),
    resolveWorkspace: (handle) => workspaceRoots.get(handle),
    clear: () => {
      projects.clear()
      workspaces.clear()
      projectRoots.clear()
      workspaceRoots.clear()
      externalSessions.clear()
      externalTargets.clear()
      nextProject = 0
      nextWorkspace = 0
      nextExternalSession = 0
    },
  }
}

function externalSessionKey(key: SessionsExternalSessionKey): string {
  return `${key.sourceId}\u0000${key.hostId}\u0000${key.key}`
}

export function sessionsProjectionRootKey(hostId: string, path: string): string {
  return `${hostId}\u0000${path}`
}
