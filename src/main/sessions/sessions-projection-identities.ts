import {
  MAX_SESSIONS_PROJECTION_ROWS,
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
  /** Identifier in the foreign source's namespace; never leaves main. */
  readonly key: string
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
  externalSession(key: SessionsExternalSessionKey): SessionsTerminalHandle | undefined
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
    externalSession: (key) => {
      const mapKey = `${key.sourceId}\u0000${key.key}`
      const current = externalSessions.get(mapKey)
      if (current) return current
      if (externalSessions.size >= MAX_EXTERNAL_SESSION_HANDLES) return undefined
      // Zero padded so the handle's lexicographic order is its minting order:
      // the projection's final tiebreak is the handle string, and minting
      // follows the source's own ordering.
      const created = asSessionsTerminalHandle(
        `sessions-external-${String((nextExternalSession += 1)).padStart(4, '0')}`,
      )
      externalSessions.set(mapKey, created)
      return created
    },
    resolveProject: (handle) => projectRoots.get(handle),
    resolveWorkspace: (handle) => workspaceRoots.get(handle),
    clear: () => {
      projects.clear()
      workspaces.clear()
      projectRoots.clear()
      workspaceRoots.clear()
      externalSessions.clear()
      nextProject = 0
      nextWorkspace = 0
      nextExternalSession = 0
    },
  }
}

export function sessionsProjectionRootKey(hostId: string, path: string): string {
  return `${hostId}\u0000${path}`
}
