import type { HostPath } from '../../shared/host-path'

/**
 * Handoffs main is carrying out right now (ADR-063). An entry spans from before the
 * handoff creates its worktree, or before a retry resumes it, until its brief write
 * settles. While an entry is held the worktree is never an unfinished handoff, whatever
 * disk and Git say, so no removal can land in the middle of a handoff.
 */
export class HandoffsInFlight {
  private readonly entries = new Map<string, number>()

  /** Holds `worktree` of `projectId` in flight; the returned release is idempotent. */
  hold(projectId: string, worktree: HostPath): () => void {
    const key = keyOf(projectId, worktree)
    this.entries.set(key, (this.entries.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.entries.get(key) ?? 1) - 1
      if (remaining === 0) this.entries.delete(key)
      else this.entries.set(key, remaining)
    }
  }

  has(projectId: string, worktree: HostPath): boolean {
    return this.entries.has(keyOf(projectId, worktree))
  }
}

function keyOf(projectId: string, worktree: HostPath): string {
  return JSON.stringify([projectId, worktree.hostId, worktree.path])
}
