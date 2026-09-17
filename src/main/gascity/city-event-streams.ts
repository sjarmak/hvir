/**
 * One city event stream per host that has an open project, owned by main.
 *
 * Lifetime follows open projects, not a view. A host with a project open and a
 * reachable city has exactly one subscription, however many of its projects are
 * open; the last project on that host closing closes the stream and its channel.
 * Nothing in Sessions owns any of this: a global list that happens to be hidden
 * changes nothing here, which is the point, because a blocked agent has to be
 * able to raise attention with no view open at all (ADR-048).
 *
 * The stream carries session lifecycle transitions and no message content, so a
 * host-wide subscription stays affordable. Pending interactions come from the
 * city's own declared list, read alongside the stream: the city event vocabulary
 * has no pending event, and inferring one from lifecycle traffic is exactly the
 * guess ADR-048 refuses. Every read is one loopback GET of a three-field list.
 *
 * Transport loss never reconnects by itself. The host's facts are marked stale
 * with the reason they stopped being watched, and {@link resume} is the explicit
 * resumption ADR-047 requires.
 */
import type { HostId, HostPath } from '../../shared'
import type { Disposer } from '../project-host'
import {
  foldCityLifecycleEvent,
  foldCityPending,
  liveHostCityEvents,
  lostHostCityEvents,
  openingHostCityEvents,
  unavailableHostCityEvents,
  withdrawCityPending,
  type CityEventStreamReason,
  type HostCityEvents,
} from './city-event-facts'
import type { SupervisorAccess, SupervisorSessionAddress } from './supervisor-access'
import type { SupervisorStreamSubscription } from './supervisor-client'

/** A host worth watching: one with an open project, and the city root if known. */
export interface CityEventStreamHost {
  readonly hostId: HostId
  readonly cityRoot?: HostPath
}

export interface GasCityEventStreamsOptions {
  readonly access: SupervisorAccess
  /**
   * Hosts with at least one open project. Called on every reconcile, so a host
   * whose last project closed simply stops appearing, and a host hvir is not
   * connected to is unreachable through the access rather than dialed.
   */
  readonly hosts: () => readonly CityEventStreamHost[]
  /** Fires when that set may have changed (a project or host change). */
  readonly observeHosts: (listener: () => void) => Disposer
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Injectable for tests; defaults to `setInterval`. */
  readonly schedule?: (tick: () => void, everyMs: number) => Disposer
}

/**
 * How often a live host's declared pending list is read. The attention signal is
 * exact but has no event to arrive on, so this cadence is the whole discovery
 * path for it; answering withdraws an interaction immediately rather than waiting
 * for the next read (ADR-048).
 */
export const CITY_PENDING_POLL_MS = 5_000

interface HostStream {
  facts: HostCityEvents
  /** Bumped whenever this host's stream is replaced, closed, or resumed. */
  generation: number
  subscription?: SupervisorStreamSubscription
  address?: SupervisorSessionAddress
  /** A pending-list read is in flight; another tick does not start a second. */
  reading?: boolean
}

export class GasCityEventStreams {
  private readonly streams = new Map<HostId, HostStream>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private hostsDisposer?: Disposer
  private pollDisposer?: Disposer
  private started = false
  private disposed = false

  constructor(private readonly options: GasCityEventStreamsOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /** Begins following open projects. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.hostsDisposer = this.options.observeHosts(this.reconcile)
    this.reconcile()
  }

  /** What is known right now, one entry per host being followed. */
  observationSnapshot(): readonly HostCityEvents[] {
    return [...this.streams.values()]
      .map((stream) => stream.facts)
      .sort((left, right) => left.hostId.localeCompare(right.hostId))
  }

  /**
   * Notification only. Observing does not keep a stream open and releasing does
   * not close one: the lifetime is the open projects', which is what lets a
   * closed view still raise attention.
   */
  observe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Reopens one host's stream from the sequence it last received. The explicit
   * resumption ADR-047 requires: a lost stream is never re-subscribed on its
   * own, because a silent reconnect replaces one unverified state with another.
   */
  resume(hostId: HostId): void {
    const stream = this.streams.get(hostId)
    if (stream === undefined || this.disposed) return
    if (stream.facts.stream === 'live' || stream.facts.stream === 'opening') return
    this.closeStream(stream)
    stream.generation += 1
    stream.facts = { ...stream.facts, stream: 'opening' }
    this.changed()
    void this.open(hostId, stream, stream.generation)
  }

  /**
   * Withdraws one answered interaction from a host's facts. Called by whoever
   * performed the mutation, so the badge clears on the answer.
   */
  withdrawPending(hostId: HostId, requestId: string): void {
    const stream = this.streams.get(hostId)
    if (stream === undefined) return
    const next = withdrawCityPending(stream.facts, requestId)
    if (next.pending.length === stream.facts.pending.length) return
    stream.facts = next
    this.changed()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const disposers = [this.pollDisposer, this.hostsDisposer]
    this.pollDisposer = undefined
    this.hostsDisposer = undefined
    for (const dispose of disposers.reverse()) void dispose?.()
    for (const stream of this.streams.values()) this.closeStream(stream)
    this.streams.clear()
    this.listeners.clear()
  }

  /**
   * One pass over the hosts with open projects: a host that gained its first
   * open project gets a stream, a host that lost its last one has its stream and
   * channel closed.
   */
  private readonly reconcile = (): void => {
    if (this.disposed || !this.started) return
    const wanted = new Map<HostId, HostPath | undefined>()
    for (const host of this.options.hosts()) {
      if (!wanted.has(host.hostId)) wanted.set(host.hostId, host.cityRoot)
    }
    let changed = false
    for (const [hostId, stream] of [...this.streams]) {
      if (wanted.has(hostId)) continue
      this.closeStream(stream)
      stream.generation += 1
      this.streams.delete(hostId)
      changed = true
    }
    for (const [hostId, cityRoot] of wanted) {
      if (this.streams.has(hostId)) continue
      const stream: HostStream = {
        facts: openingHostCityEvents(hostId, cityRoot, this.now()),
        generation: 1,
      }
      this.streams.set(hostId, stream)
      changed = true
      void this.open(hostId, stream, stream.generation)
    }
    if (this.streams.size === 0) this.stopPolling()
    else this.startPolling()
    if (changed) this.changed()
  }

  private async open(
    hostId: HostId,
    stream: HostStream,
    generation: number,
  ): Promise<void> {
    const address = await this.options.access.address({
      hostId,
      ...(stream.facts.cityRoot === undefined ? {} : { cityRoot: stream.facts.cityRoot }),
    })
    if (!this.current(hostId, stream, generation)) return
    if (!address.ok) {
      this.settle(stream, unavailableHostCityEvents(stream.facts, address.failure.reason))
      return
    }
    stream.address = address.value
    const subscription = await address.value.client.streamCity(
      address.value.cityName,
      {
        onEvent: (event) => {
          if (!this.current(hostId, stream, generation)) return
          if (event.kind === 'unrecognized') return
          // A keep-alive confirms the facts without changing any of them, so it
          // refreshes the observation and wakes nobody.
          if (event.kind === 'heartbeat') {
            stream.facts = liveHostCityEvents(stream.facts, this.now())
            return
          }
          stream.facts = foldCityLifecycleEvent(
            stream.facts,
            event.data,
            stream.subscription?.cursor ?? String(event.data.seq),
            this.now(),
          )
          this.changed()
        },
        onClose: (failure) => {
          if (!this.current(hostId, stream, generation)) return
          this.fail(stream, failure?.reason ?? 'closed')
        },
      },
      stream.facts.cursor,
    )
    // The host's last project may have closed while the channel was opening.
    if (!this.current(hostId, stream, generation)) {
      subscription.close()
      return
    }
    stream.subscription = subscription
    this.settle(stream, liveHostCityEvents(stream.facts, this.now()))
    void this.readPending(hostId, stream, generation)
  }

  /** The city's declared pending interactions, for one live host. */
  private async readPending(
    hostId: HostId,
    stream: HostStream,
    generation: number,
  ): Promise<void> {
    const address = stream.address
    if (address === undefined || stream.reading === true) return
    stream.reading = true
    const result = await address.client.cityPending(address.cityName)
    stream.reading = false
    if (!this.current(hostId, stream, generation)) return
    if (stream.facts.stream !== 'live') return
    // A failed read does not empty the list: a pending interaction that is no
    // longer being confirmed is stale, not resolved. A supervisor that cannot
    // answer for its own city is not watching this host any more, so the stream
    // goes down with the reason rather than staying up and asserting freshness
    // its pending facts no longer have.
    if (!result.ok) {
      this.fail(stream, result.failure.reason)
      return
    }
    this.settle(
      stream,
      foldCityPending(stream.facts, result.value.items ?? [], this.now()),
    )
  }

  private startPolling(): void {
    if (this.pollDisposer !== undefined) return
    const schedule = this.options.schedule ?? defaultSchedule
    this.pollDisposer = schedule(this.pollPending, CITY_PENDING_POLL_MS)
  }

  private stopPolling(): void {
    const dispose = this.pollDisposer
    this.pollDisposer = undefined
    void dispose?.()
  }

  private readonly pollPending = (): void => {
    if (this.disposed) return
    for (const [hostId, stream] of this.streams) {
      if (stream.facts.stream !== 'live') continue
      void this.readPending(hostId, stream, stream.generation)
    }
  }

  /** Whether this stream record is still the host's, at this generation. */
  private current(hostId: HostId, stream: HostStream, generation: number): boolean {
    if (this.disposed) return false
    return this.streams.get(hostId) === stream && stream.generation === generation
  }

  /**
   * Stops watching one host and says why. The facts stay; what changes is the
   * claim hvir makes about them. Nothing reopens until {@link resume}.
   */
  private fail(stream: HostStream, reason: CityEventStreamReason): void {
    this.closeStream(stream)
    stream.generation += 1
    this.settle(stream, lostHostCityEvents(stream.facts, reason))
  }

  private settle(stream: HostStream, facts: HostCityEvents): void {
    if (facts === stream.facts) return
    stream.facts = facts
    this.changed()
  }

  private closeStream(stream: HostStream): void {
    const subscription = stream.subscription
    stream.subscription = undefined
    stream.address = undefined
    stream.reading = false
    subscription?.close()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

function defaultSchedule(tick: () => void, everyMs: number): Disposer {
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
