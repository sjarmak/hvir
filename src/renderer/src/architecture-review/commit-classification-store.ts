import type { HostPath } from '../../../shared'
import {
  ARCHITECTURE_CLASSIFY_LIMIT,
  type ArchitectureCommitChange,
  type ArchitectureCommitClassifyRequest,
  type ArchitectureCommitClassifyResult,
  type FleetCommitClassification,
} from '../../../shared/architecture-review'

export type CommitClassifications = ReadonlyMap<string, ArchitectureCommitChange>
export type FleetClassifications = ReadonlyMap<string, FleetCommitClassification>

export interface CommitClassificationState {
  readonly known: CommitClassifications
  readonly fleet: FleetClassifications
  readonly pending: ReadonlySet<string>
  readonly generation: number
  readonly head?: string
  readonly error?: string
}

export type ClassifyInvoke = (
  request: ArchitectureCommitClassifyRequest,
) => Promise<ArchitectureCommitClassifyResult>

const defaultInvoke: ClassifyInvoke = (request) =>
  window.hvir.invoke('architecture-review:classify-commits', request)

export class CommitClassificationStore {
  private readonly known = new Map<string, ArchitectureCommitChange>()
  private readonly fleet = new Map<string, FleetCommitClassification>()
  private readonly requested = new Set<string>()
  private readonly demand = new Map<string, number>()
  private queue: string[] = []
  private readonly listeners = new Set<() => void>()
  private head: string | undefined
  private error: string | undefined
  private epoch = 0
  private generation = 0
  private inFlight = false
  private released = false
  private snapshot: CommitClassificationState = {
    known: new Map(),
    fleet: new Map(),
    pending: new Set(),
    generation: 0,
  }

  constructor(
    private readonly root: HostPath,
    private readonly invoke: ClassifyInvoke = defaultInvoke,
  ) {}

  readonly read = (): CommitClassificationState => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  retain(revisions: readonly string[]): () => void {
    if (this.released) return () => undefined
    for (const revision of revisions)
      this.demand.set(revision, (this.demand.get(revision) ?? 0) + 1)
    this.enqueue(revisions)
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      for (const revision of revisions) {
        const count = (this.demand.get(revision) ?? 0) - 1
        if (count > 0) this.demand.set(revision, count)
        else this.demand.delete(revision)
      }
      this.prune()
    }
  }

  private enqueue(revisions: readonly string[]): void {
    let added = false
    for (const revision of revisions) {
      if (this.requested.has(revision)) continue
      this.requested.add(revision)
      this.queue.push(revision)
      added = true
    }
    if (!added) return
    this.error = undefined
    this.publish()
    if (!this.inFlight) void this.drain()
  }

  invalidate(head: string): void {
    if (this.released || head === this.head) return
    this.head = head
    this.reset()
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.head = undefined
    this.reset()
  }

  private prune(): void {
    if (this.released) return
    const kept = this.queue.filter((revision) => this.demand.has(revision))
    if (kept.length === this.queue.length) return
    for (const revision of this.queue)
      if (!this.demand.has(revision)) this.requested.delete(revision)
    this.queue = kept
    this.publish()
  }

  private reset(): void {
    this.epoch += 1
    this.generation += 1
    this.known.clear()
    this.fleet.clear()
    this.requested.clear()
    this.queue = []
    this.error = undefined
    this.publish()
  }

  private async drain(): Promise<void> {
    this.inFlight = true
    try {
      while (this.queue.length > 0) {
        const epoch = this.epoch
        const batch = this.queue.splice(0, ARCHITECTURE_CLASSIFY_LIMIT)
        try {
          const result = await this.invoke({ root: this.root, revisions: batch })
          if (epoch !== this.epoch) continue
          this.accept(result)
        } catch (cause) {
          if (epoch !== this.epoch) continue
          for (const revision of batch) this.requested.delete(revision)
          if (batch.some((revision) => this.demand.has(revision)))
            this.error = cause instanceof Error ? cause.message : 'Classification failed'
        }
        this.publish()
      }
    } finally {
      this.inFlight = false
    }
  }

  private accept(result: ArchitectureCommitClassifyResult): void {
    if (this.head !== undefined && result.head !== this.head) {
      this.generation += 1
      this.known.clear()
      this.fleet.clear()
      for (const revision of this.requested)
        if (!this.queue.includes(revision)) this.requested.delete(revision)
    }
    this.head = result.head
    for (const answer of result.classifications) {
      this.known.set(answer.revision, answer.change)
      if (answer.fleet) this.fleet.set(answer.revision, answer.fleet)
      else this.fleet.delete(answer.revision)
      this.requested.add(answer.revision)
    }
  }

  private publish(): void {
    const pending = new Set<string>()
    for (const revision of this.requested)
      if (!this.known.has(revision)) pending.add(revision)
    this.snapshot = {
      known: new Map(this.known),
      fleet: new Map(this.fleet),
      pending,
      generation: this.generation,
      ...(this.head === undefined ? {} : { head: this.head }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
    for (const listener of this.listeners) listener()
  }
}

const stores = new Map<string, CommitClassificationStore>()

const keyOf = (root: HostPath) => `${root.hostId}\0${root.path}`

export function commitClassificationStore(
  root: HostPath,
  invoke: ClassifyInvoke = defaultInvoke,
): CommitClassificationStore {
  const key = keyOf(root)
  let store = stores.get(key)
  if (!store) {
    store = new CommitClassificationStore(root, invoke)
    stores.set(key, store)
  }
  return store
}

export function releaseCommitClassificationStore(root: HostPath): void {
  const key = keyOf(root)
  stores.get(key)?.release()
  stores.delete(key)
}
