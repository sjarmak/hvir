import type { ArchitectureCommitChange } from '../../shared/architecture-review'
import type { HostPath } from '../../shared/host-path'

export interface CommitChangeKey {
  readonly root: HostPath
  readonly revision: string
  readonly parent: string | null
  readonly scanners: string
  readonly layout: string
}

export class CommitChangeCache {
  private readonly entries = new Map<string, ArchitectureCommitChange>()

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error('Commit change cache needs a positive entry bound')
  }

  get size(): number {
    return this.entries.size
  }

  lookup(key: CommitChangeKey): ArchitectureCommitChange | undefined {
    const name = keyName(key)
    const change = this.entries.get(name)
    if (change === undefined) return undefined
    this.entries.delete(name)
    this.entries.set(name, change)
    return change
  }

  store(key: CommitChangeKey, change: ArchitectureCommitChange): void {
    const name = keyName(key)
    this.entries.delete(name)
    this.entries.set(name, change)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

function keyName(key: CommitChangeKey): string {
  return [
    key.root.hostId,
    key.root.path,
    key.revision,
    key.parent ?? '',
    key.scanners,
    key.layout,
  ].join('\0')
}
