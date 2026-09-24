import type { HostPath } from './host-path'

/**
 * Agent handoff into a worktree hvir owns (ADR-063). Preparing a launch shows the exact
 * branch, worktree, starting commit, brief and prompt; the handoff creates them once.
 */

/** The untracked brief hvir writes at the worktree root and excludes from Git. */
export const ARCHITECTURE_BRIEF_FILE = '.hvir-architecture-brief.md'

export interface ArchitectureHandoffPlan {
  readonly branch: string
  readonly worktree: HostPath
  /** The full commit the branch starts at: the original Current end. */
  readonly commit: string
  /** The brief's full text, as it will be written. */
  readonly brief: string
}

/** Main's one-shot authority to start the agent session inside the created worktree. */
export interface ArchitectureAgentLaunch {
  readonly handoffId: string
  /** The created worktree; the agent's workspace and working directory. */
  readonly root: HostPath
  readonly digest: string
}

export interface ArchitectureHandoff {
  readonly projectId: string
  readonly workspaceId: string
  readonly branch: string
  readonly worktree: HostPath
  readonly launch: ArchitectureAgentLaunch
}

/**
 * The ends of the snapshot a worktree was handed off from, both as commits. Re-snapshotting
 * the worktree against `current` shows only the agent's change; against `baseline`, the
 * cumulative result.
 */
export interface ArchitectureHandoffOrigin {
  readonly baselineRef: string
  readonly baselineRevision: string
  readonly currentRef: string
  readonly currentRevision: string
}

export interface ArchitectureOriginRequest {
  readonly root: HostPath
}
