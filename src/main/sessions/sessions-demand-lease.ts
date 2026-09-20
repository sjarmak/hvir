/**
 * The demand lease every Sessions port holds, in one place.
 *
 * Three ports lease observation to a renderer or a companion page, and each
 * used to keep its own copy of the same rules: one lease per owner, keyed so a
 * companion never collides with a renderer (ADR-049); a second acquire at a
 * different generation refused rather than silently retargeted; a release that
 * names the generation it is releasing, so a stale release cannot take a live
 * lease; and a lease that stops being current the moment the map moves on or
 * the port is disposed, which is what a callback arriving late must check
 * before it writes anything.
 *
 * Those rules are one thing, so they live in one place. What a lease *holds* is
 * still the port's own business: this registry never looks inside `TLease` past
 * the owner and the generation, and teardown is handed back to the port rather
 * than guessed at here.
 */
import type { Disposer } from '../project-host'
import { demandOwnerKey, type SessionsDemandOwner } from './sessions-demand-owner'

/** What every lease carries, whatever else the port puts in it. */
export interface SessionsDemandLease {
  readonly owner: SessionsDemandOwner
  readonly demandGeneration: number
}

/** One lease per owner, with the staleness rules the ports share. */
export class SessionsDemandLeases<TLease extends SessionsDemandLease> {
  private readonly leases = new Map<string, TLease>()
  private isDisposed = false

  get disposed(): boolean {
    return this.isDisposed
  }

  get size(): number {
    return this.leases.size
  }

  /** The leases held now, as a snapshot: a walk may release as it goes. */
  all(): readonly TLease[] {
    return [...this.leases.values()]
  }

  /** This owner's lease at any generation, for a caller that checks its own. */
  get(owner: SessionsDemandOwner): TLease | undefined {
    return this.leases.get(demandOwnerKey(owner))
  }

  /** This owner's lease only while it is the generation asked for. */
  at(owner: SessionsDemandOwner, demandGeneration: number): TLease | undefined {
    const lease = this.get(owner)
    return lease?.demandGeneration === demandGeneration ? lease : undefined
  }

  /**
   * The current lease, or the port's own words for why there is none. The
   * message belongs to the caller: a renderer reads it, and each port names
   * what it was leasing.
   */
  require(
    owner: SessionsDemandOwner,
    demandGeneration: number,
    message: string,
  ): TLease {
    const lease = this.at(owner, demandGeneration)
    if (!lease) throw new Error(message)
    return lease
  }

  add(lease: TLease): void {
    this.leases.set(demandOwnerKey(lease.owner), lease)
  }

  /** Takes the lease out and hands it back, or nothing when the release is stale. */
  remove(owner: SessionsDemandOwner, demandGeneration: number): TLease | undefined {
    const lease = this.at(owner, demandGeneration)
    if (!lease) return undefined
    this.leases.delete(demandOwnerKey(owner))
    return lease
  }

  /**
   * Whether this exact lease is still the one held for its owner. A callback
   * that captured a lease asks before it writes: the owner may have released,
   * reacquired at a new generation, or the port may be gone. Disposal needs no
   * separate test here, because it empties the registry.
   */
  owns(lease: TLease): boolean {
    return this.get(lease.owner) === lease
  }

  /**
   * Empties the registry and hands back what was in it for the port to tear
   * down. Idempotent by construction: a second call finds nothing to hand back.
   */
  dispose(): readonly TLease[] {
    this.isDisposed = true
    const held = this.all()
    this.leases.clear()
    return held
  }
}

/**
 * One subscription to the source, opened with the first lease and closed with
 * the last. Lazy because a port with no lease observes nothing (ADR-046), and
 * idempotent because every lease calls `start`.
 */
export class SessionsSourceObservation {
  private stopObserving?: Disposer

  constructor(private readonly observe: () => Disposer) {}

  start(): void {
    this.stopObserving ??= this.observe()
  }

  /** Closes the subscription once no lease is left to feed. */
  stopIfIdle(leases: { readonly size: number }): void {
    if (leases.size > 0) return
    this.stop()
  }

  stop(): void {
    void this.stopObserving?.()
    this.stopObserving = undefined
  }
}

/** A lease that coalesces its change notifications onto one microtask. */
export interface SessionsNotifyingLease {
  notifyQueued: boolean
}

/**
 * One notification per microtask, whatever moved in it. The flag clears before
 * `emit` runs, so a change made by the emit itself queues the next one rather
 * than being swallowed; `emit` is where the port checks the lease is still its
 * own.
 */
export function queueLeaseNotification(
  lease: SessionsNotifyingLease,
  emit: () => void,
): void {
  if (lease.notifyQueued) return
  lease.notifyQueued = true
  queueMicrotask(() => {
    lease.notifyQueued = false
    emit()
  })
}
