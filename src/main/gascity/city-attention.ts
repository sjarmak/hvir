/**
 * Pending interactions, placed and counted for hvir's own attention rollup.
 *
 * A declared pending interaction is a person being waited on, so it belongs in
 * the same rollup a terminal waiting on you does (ADR-009, ADR-048). This owner
 * turns the per-host city facts into per-workspace counts: the project tab and
 * the nav then aggregate them without knowing where they came from.
 *
 * It is always on, because the signal has to arrive with the Sessions view
 * closed. That rules out the `gc` reader the projection uses, which is a CLI
 * round trip per host and only runs while something is observing Sessions.
 * Placement here comes from the supervisor's own session list over the same
 * loopback channel the stream uses, read lazily: only when a pending session is
 * one this owner has not placed before, and cached per host afterwards.
 *
 * Placement itself is not decided here. It is the one rule in
 * {@link placeCitySession}, shared with the Sessions projection, so a row and
 * its attention cannot land in different workspaces.
 *
 * Staleness travels with the count. When a host's stream is down the entries
 * from it are marked with the reason it went down: ADR-048 forbids dropping a
 * pending interaction and forbids asserting one nobody is watching.
 *
 * The same pass also keeps the per-session list the actionable set consumes
 * (ADR-049): what the nav gets as a count, the Companion gets as sessions.
 * That list carries foreign identifiers and stays in main (ADR-046).
 */
import {
  EMPTY_EXTERNAL_ATTENTION,
  EXTERNAL_ATTENTION_VERSION,
  hostPath,
  MAX_EXTERNAL_ATTENTION_ENTRIES,
  MAX_EXTERNAL_ATTENTION_WAITING,
  type ActionableFreshness,
  type ExternalAttentionEntry,
  type ExternalAttentionSnapshot,
  type ExternalAttentionStaleReason,
  type HostId,
  type HostPath,
} from '../../shared'
import type { Disposer } from '../project-host'
import { placeCitySession, type CityPlacementTarget } from './city-session-placement'
import type { CityEventStreamReason, HostCityEvents } from './city-event-facts'
import type { SupervisorAccess } from './supervisor-access'

/** A workspace an interaction can be placed in, with the project it belongs to. */
export interface CityAttentionWorkspaceTarget {
  readonly workspaceId: string
  readonly root: HostPath
  readonly projectRoot: HostPath
  /** However the caller names projects; only equality is used. */
  readonly projectKey: string
  readonly main: boolean
}

/** One pending interaction, placed, for the actionable set. Main only. */
export interface ExternalPendingSession {
  readonly hostId: HostId
  readonly sessionKey: string
  readonly cityRoot?: HostPath
  readonly workspaceId: string
  /** gc's kind word, verbatim. */
  readonly kind: string
  readonly freshness: ActionableFreshness
  readonly reason?: ExternalAttentionStaleReason
  /** The session's own title, when the placement read carried one. */
  readonly title?: string
}

/** The notification surface of the city event streams, and nothing more. */
export interface CityAttentionStreams {
  observationSnapshot(): readonly HostCityEvents[]
  observe(listener: () => void): Disposer
}

export interface GasCityAttentionOptions {
  readonly streams: CityAttentionStreams
  readonly access: SupervisorAccess
  /** Workspaces of the projects open right now, host-qualified. */
  readonly workspaces: () => readonly CityAttentionWorkspaceTarget[]
  /** Fires when that set may have changed. */
  readonly observeWorkspaces: (listener: () => void) => Disposer
  /** Called with every new snapshot, in order. */
  readonly publish: (snapshot: ExternalAttentionSnapshot) => void
}

/**
 * How many sessions one placement read asks for. A city larger than this is
 * read in full for the first page only: the pending sessions that matter are
 * the ones a person is being asked about, and an unplaced one is left out
 * rather than guessed at.
 */
const PLACEMENT_READ_LIMIT = 500

/** Where one session is working, as the supervisor's list reported it. */
interface CitySessionPlace {
  readonly workDir?: HostPath
  readonly title?: string
}

interface HostPlacements {
  /** Sessions the last read returned, by gc's own session identifier. */
  readonly places: Map<string, CitySessionPlace>
  /** Sessions a read looked for and did not find; asking again would loop. */
  readonly missing: Set<string>
  /** A read is in flight; a second recompute does not start another. */
  reading: boolean
}

export class GasCityAttention {
  private readonly placements = new Map<HostId, HostPlacements>()
  private current: ExternalAttentionSnapshot = EMPTY_EXTERNAL_ATTENTION
  private pending: readonly ExternalPendingSession[] = []
  private readonly pendingListeners = new Set<() => void>()
  private disposers: readonly Disposer[] = []
  private started = false
  private disposed = false

  constructor(private readonly options: GasCityAttentionOptions) {}

  /** Begins following the streams and the open workspaces. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.disposers = [
      this.options.streams.observe(this.recompute),
      this.options.observeWorkspaces(this.recompute),
    ]
    this.recompute()
  }

  /** The snapshot a renderer that just asked should hold. */
  snapshot(): ExternalAttentionSnapshot {
    return this.current
  }

  /** The placed pending interactions behind {@link snapshot}, one per session. */
  pendingSessions(): readonly ExternalPendingSession[] {
    return this.pending
  }

  /** Fires after {@link pendingSessions} changed, once the snapshot is published. */
  observePending(listener: () => void): Disposer {
    this.pendingListeners.add(listener)
    return () => {
      this.pendingListeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const disposers = [...this.disposers].reverse()
    this.disposers = []
    for (const dispose of disposers) void dispose()
    this.placements.clear()
    this.pending = []
    this.pendingListeners.clear()
  }

  private readonly recompute = (): void => {
    if (this.disposed) return
    const hosts = this.options.streams.observationSnapshot()
    this.forgetHostsAway(hosts)
    const targets = this.targetsByHost()
    const counts = new Map<string, ExternalAttentionEntry>()
    const pending: ExternalPendingSession[] = []
    for (const facts of hosts) {
      const hostTargets = targets.get(facts.hostId) ?? []
      // A host with no pending interaction contributes nothing, stale or not:
      // there is no attention to mark.
      if (facts.pending.length === 0 || hostTargets.length === 0) continue
      // Reading is deferred to here so one read covers every unplaced session
      // on the host, and so a host whose sessions are all placed never reads.
      if (this.collect(facts, hostTargets, counts, pending)) void this.read(facts)
    }
    this.settle(counts, pending)
  }

  /** Folds one host's pending facts in; true when a session could not be placed. */
  private collect(
    facts: HostCityEvents,
    hostTargets: readonly CityPlacementTarget<string>[],
    counts: Map<string, ExternalAttentionEntry>,
    pending: ExternalPendingSession[],
  ): boolean {
    const places = this.placementsFor(facts.hostId)
    const stale = staleOf(facts)
    let unplaced = false
    for (const fact of facts.pending) {
      const place = places.places.get(fact.sessionKey)
      if (place === undefined) {
        if (!places.missing.has(fact.sessionKey)) unplaced = true
        continue
      }
      const workspaceId = placeCitySession(place, hostTargets)
      if (workspaceId === undefined) continue
      add(counts, workspaceId, stale)
      pending.push({
        hostId: facts.hostId,
        sessionKey: fact.sessionKey,
        ...(facts.cityRoot === undefined ? {} : { cityRoot: facts.cityRoot }),
        workspaceId,
        kind: fact.kind,
        ...(stale.stale === true && stale.reason !== undefined
          ? { freshness: 'stale', reason: stale.reason }
          : { freshness: 'fresh' }),
        ...(place.title === undefined ? {} : { title: place.title }),
      })
    }
    return unplaced
  }

  /**
   * One host's session list, for the sessions this owner could not place. The
   * read is a description; it never starts or attaches anything (ADR-046), and
   * a failure leaves the placements as they were rather than emptying them.
   */
  private async read(facts: HostCityEvents): Promise<void> {
    const placements = this.placementsFor(facts.hostId)
    if (placements.reading) return
    placements.reading = true
    const address = await this.options.access.address({
      hostId: facts.hostId,
      ...(facts.cityRoot === undefined ? {} : { cityRoot: facts.cityRoot }),
    })
    if (this.disposed) return
    if (!address.ok) {
      placements.reading = false
      return
    }
    const result = await address.value.client.sessions(address.value.cityName, {
      limit: PLACEMENT_READ_LIMIT,
    })
    placements.reading = false
    if (this.disposed || this.placements.get(facts.hostId) !== placements) return
    if (!result.ok) return
    placements.places.clear()
    for (const session of result.value.items ?? []) {
      if (session.work_dir === undefined || session.work_dir === '') continue
      placements.places.set(session.id, {
        workDir: hostPath(facts.hostId, session.work_dir),
        ...(session.title === undefined || session.title === ''
          ? {}
          : { title: session.title }),
      })
    }
    // What the city itself did not report is not asked for again, so a session
    // the supervisor has no record of cannot drive a read on every recompute.
    placements.missing.clear()
    for (const pending of this.pendingOf(facts.hostId)) {
      if (!placements.places.has(pending)) placements.missing.add(pending)
    }
    this.recompute()
  }

  /** The pending session keys the host holds right now, not when the read began. */
  private pendingOf(hostId: HostId): readonly string[] {
    const facts = this.options.streams
      .observationSnapshot()
      .find((candidate) => candidate.hostId === hostId)
    return facts === undefined ? [] : facts.pending.map((entry) => entry.sessionKey)
  }

  private placementsFor(hostId: HostId): HostPlacements {
    const held = this.placements.get(hostId)
    if (held !== undefined) return held
    const created: HostPlacements = {
      places: new Map(),
      missing: new Set(),
      reading: false,
    }
    this.placements.set(hostId, created)
    return created
  }

  /** A host that is no longer followed keeps nothing cached. */
  private forgetHostsAway(hosts: readonly HostCityEvents[]): void {
    const followed = new Set(hosts.map((facts) => facts.hostId))
    for (const hostId of [...this.placements.keys()]) {
      if (!followed.has(hostId)) this.placements.delete(hostId)
    }
  }

  private targetsByHost(): ReadonlyMap<HostId, readonly CityPlacementTarget<string>[]> {
    const byHost = new Map<HostId, CityPlacementTarget<string>[]>()
    for (const target of this.options.workspaces()) {
      const targets = byHost.get(target.root.hostId) ?? []
      targets.push({
        root: target.root,
        projectRoot: target.projectRoot,
        projectKey: target.projectKey,
        main: target.main,
        value: target.workspaceId,
      })
      byHost.set(target.root.hostId, targets)
    }
    return byHost
  }

  private settle(
    counts: ReadonlyMap<string, ExternalAttentionEntry>,
    pending: readonly ExternalPendingSession[],
  ): void {
    const entries = [...counts.values()]
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
      .slice(0, MAX_EXTERNAL_ATTENTION_ENTRIES)
    if (!sameEntries(this.current.entries, entries)) {
      this.current = {
        version: EXTERNAL_ATTENTION_VERSION,
        revision: this.current.revision + 1,
        entries,
      }
      this.options.publish(this.current)
    }
    // Pending observers run after the publish, so a consumer that reads both
    // sees the snapshot the sessions belong to, and never re-enters publish.
    if (samePending(this.pending, pending)) return
    this.pending = pending
    for (const listener of [...this.pendingListeners]) listener()
  }
}

/**
 * Whether a host's facts can be asserted as current, and the reason when they
 * cannot. The stream's own vocabulary is the shared one, so this is a widening
 * rather than a translation.
 */
function staleOf(facts: HostCityEvents): {
  readonly stale?: true
  readonly reason?: ExternalAttentionStaleReason
} {
  if (facts.stream === 'live') return {}
  return { stale: true, reason: staleReason(facts.reason) }
}

function staleReason(
  reason: CityEventStreamReason | undefined,
): ExternalAttentionStaleReason {
  // `opening` carries no reason: hvir is not watching yet, which is the same
  // claim as a closed stream and the same thing to tell a person.
  return reason ?? 'closed'
}

/**
 * One more interaction in a workspace. A stale contribution makes the whole
 * entry stale: a count that is part unverified is unverified.
 */
function add(
  counts: Map<string, ExternalAttentionEntry>,
  workspaceId: string,
  stale: { readonly stale?: true; readonly reason?: ExternalAttentionStaleReason },
): void {
  const held = counts.get(workspaceId)
  const waiting = Math.min((held?.waiting ?? 0) + 1, MAX_EXTERNAL_ATTENTION_WAITING)
  const carried =
    held?.stale === true ? { stale: held.stale, reason: held.reason } : stale
  counts.set(workspaceId, {
    workspaceId,
    waiting,
    ...(carried.stale === true && carried.reason !== undefined
      ? { stale: carried.stale, reason: carried.reason }
      : {}),
  })
}

function samePending(
  left: readonly ExternalPendingSession[],
  right: readonly ExternalPendingSession[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      entry.hostId === other.hostId &&
      entry.sessionKey === other.sessionKey &&
      entry.cityRoot?.path === other.cityRoot?.path &&
      entry.workspaceId === other.workspaceId &&
      entry.kind === other.kind &&
      entry.freshness === other.freshness &&
      entry.reason === other.reason &&
      entry.title === other.title
    )
  })
}

function sameEntries(
  left: readonly ExternalAttentionEntry[],
  right: readonly ExternalAttentionEntry[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      entry.workspaceId === other.workspaceId &&
      entry.waiting === other.waiting &&
      entry.stale === other.stale &&
      entry.reason === other.reason
    )
  })
}
