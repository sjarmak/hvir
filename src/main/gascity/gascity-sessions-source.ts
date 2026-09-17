import { type GasCitySession, type HostId, type HostPath } from '../../shared'
import type { Disposer } from '../project-host'
import { deriveCitySessions, type HostCitySessions } from './gascity-city-sessions'
import type { GasCityContext } from './gascity-context'
import { SESSION_TTL_MS } from './gascity-host-cache'
import { hasProjectedTierFields } from './gascity-parse'
import type { GasCityTarget } from './gascity-reader'

/**
 * The Gas City half of a global sessions view, on demand.
 *
 * Reading a city is not free — `gc session list` runs through a login shell on
 * the project host — so this source owns no timer and no schedule. It reads
 * once when a view first asks, and after that it re-derives whenever the shared
 * {@link GasCityReader} announces a fresh session list, which is whichever
 * surface is already polling. When the last observer goes away it drops every
 * derived fact and stops paying attention.
 *
 * It never decides which hosts may be read: the caller supplies already
 * connected hosts, which is what keeps a projected row from being the reason
 * hvir dials an SSH connection.
 */

/**
 * The reads this source needs, and nothing more. `GasCityReader` provides them;
 * naming the port keeps the source testable without a host or a `gc` binary.
 */
export interface GasCitySessionsReader {
  inCity(target: GasCityTarget): Promise<boolean>
  sessions(target: GasCityTarget): Promise<readonly GasCitySession[]>
  context(target: GasCityTarget, withConfig: boolean): Promise<GasCityContext>
  attribute(hostId: HostId, city: HostPath | undefined): void
  observe(listener: () => void): Disposer
}

export interface GasCitySessionsSourceOptions {
  readonly reader: GasCitySessionsReader
  /**
   * Roots worth looking for a city under, each paired with a host that is
   * already connected. Called on every refresh, so a host that disconnects
   * simply stops appearing.
   */
  readonly candidates: () => readonly GasCityTarget[]
  /** Fires when the candidate set may have changed (a project or host change). */
  readonly observeCandidates: (listener: () => void) => Disposer
  /** Orchestration-internal sessions; matches the crew panel's default. */
  readonly includeInternals?: boolean
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Where a failed read is reported; defaults to `console.warn`. */
  readonly warn?: (message: string) => void
}

/** Roots tried per host before concluding the host holds no city. */
const MAX_CANDIDATE_ROOTS_PER_HOST = 8

export class GasCitySessionsSource {
  private readonly listeners = new Set<() => void>()
  private readonly hosts = new Map<HostId, HostCitySessions>()
  private readonly now: () => number
  private candidatesDisposer?: Disposer
  private readerDisposer?: Disposer
  /** Bumped on every lease change, so a read in flight over one can be dropped. */
  private generation = 0
  private refreshing?: Promise<void>
  private pending = false

  constructor(private readonly options: GasCitySessionsSourceOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /** What is known right now. Empty until the first read lands. */
  observationSnapshot(): readonly HostCitySessions[] {
    return [...this.hosts.values()].sort((left, right) =>
      left.root.hostId.localeCompare(right.root.hostId),
    )
  }

  observe(listener: () => void): Disposer {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      if (!this.listeners.delete(listener)) return
      if (this.listeners.size === 0) this.stop()
    }
  }

  private start(): void {
    this.generation += 1
    this.candidatesDisposer = this.options.observeCandidates(this.refresh)
    this.readerDisposer = this.options.reader.observe(this.refresh)
    this.refresh()
  }

  private stop(): void {
    this.generation += 1
    this.pending = false
    this.refreshing = undefined
    this.hosts.clear()
    const disposers = [this.readerDisposer, this.candidatesDisposer]
    this.readerDisposer = undefined
    this.candidatesDisposer = undefined
    for (const dispose of disposers.reverse()) void dispose?.()
  }

  /**
   * One pass over the candidate hosts, at most one in flight. A refresh
   * requested while one is running is collapsed into a single follow-up, so a
   * burst of source changes cannot fan out into a burst of `gc` reads.
   */
  private readonly refresh = (): void => {
    if (this.listeners.size === 0) return
    if (this.refreshing) {
      this.pending = true
      return
    }
    const generation = this.generation
    this.refreshing = this.pass(generation).finally(() => {
      this.refreshing = undefined
      if (!this.pending) return
      this.pending = false
      this.refresh()
    })
  }

  private async pass(generation: number): Promise<void> {
    const targets = new Map<HostId, GasCityTarget[]>()
    for (const target of this.options.candidates()) {
      const hostId = target.root.hostId
      const roots = targets.get(hostId) ?? []
      // Every `gc` read is host-wide, so one city per host is all that is read.
      // Several roots are still tried, because the first project on a host may
      // be the one that is not in a city.
      if (roots.length < MAX_CANDIDATE_ROOTS_PER_HOST) roots.push(target)
      targets.set(hostId, roots)
    }
    const results = await Promise.all(
      [...targets.entries()].map(async ([hostId, roots]) => ({
        hostId,
        read: await this.read(roots),
      })),
    )
    if (generation !== this.generation || this.listeners.size === 0) return
    let changed = false
    for (const hostId of [...this.hosts.keys()]) {
      if (targets.has(hostId)) continue
      this.hosts.delete(hostId)
      changed = true
    }
    for (const { hostId, read } of results) {
      const previous = this.hosts.get(hostId)
      if (read === 'absent') {
        if (previous === undefined) continue
        this.hosts.delete(hostId)
        changed = true
        continue
      }
      const next = read === 'failed' ? stale(previous) : read
      if (next === undefined) continue
      if (previous !== undefined && same(previous, next)) continue
      this.hosts.set(hostId, next)
      changed = true
    }
    if (!changed) return
    for (const listener of this.listeners) listener()
  }

  private async read(
    roots: readonly GasCityTarget[],
  ): Promise<HostCitySessions | 'absent' | 'failed'> {
    try {
      // Marker stats only: a host with no city costs no `gc` read at all.
      const target = await this.firstInCity(roots)
      if (target === undefined) return 'absent'
      const sessions = await this.options.reader.sessions(target)
      const context = await this.options.reader.context(
        target,
        !hasProjectedTierFields(sessions),
      )
      this.options.reader.attribute(target.root.hostId, context.cityRoot)
      return {
        root: target.root,
        ...(context.cityRoot === undefined ? {} : { cityRoot: context.cityRoot }),
        observedAt: this.now(),
        staleAfterMs: SESSION_TTL_MS,
        stale: false,
        sessions: deriveCitySessions({
          root: target.root,
          ...(context.cityRoot === undefined ? {} : { cityRoot: context.cityRoot }),
          sessions,
          context,
          includeInternals: this.options.includeInternals === true,
        }),
      }
    } catch {
      // The host is named, the failure is not: a read error carries whatever
      // `gc` wrote to stderr, which is not this log's to repeat.
      const warn = this.options.warn ?? ((message: string) => console.warn(message))
      warn(`Gas City sessions read failed for host ${roots[0]?.root.hostId ?? 'unknown'}`)
      return 'failed'
    }
  }

  /** The first candidate root that sits inside a city, if any does. */
  private async firstInCity(
    roots: readonly GasCityTarget[],
  ): Promise<GasCityTarget | undefined> {
    for (const root of roots) {
      if (await this.options.reader.inCity(root)) return root
    }
    return undefined
  }
}

/**
 * A failed read leaves the previous sessions in place, marked stale, so the
 * view reports an unavailable source instead of silently emptying. A host that
 * never read successfully has nothing to keep.
 */
function stale(previous: HostCitySessions | undefined): HostCitySessions | undefined {
  return previous === undefined ? undefined : { ...previous, stale: true }
}

function same(left: HostCitySessions, right: HostCitySessions): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
