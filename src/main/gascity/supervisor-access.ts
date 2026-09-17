/**
 * Which supervisor answers for a projected session, and under what city name.
 *
 * One client per host, built from a host hvir is already connected to. A client
 * is never built for a host hvir would have to dial: a row someone else's agent
 * produced must not be the reason hvir opens a connection (ADR-046).
 *
 * The city name is the supervisor's own, resolved from the city root the
 * projection recorded and cached briefly, because every verb needs it and a
 * city list is a round trip of its own. The endpoint is still declared, not
 * discovered (ADR-047): this resolves a name inside a declared endpoint.
 */
import type { HostId, HostPath } from '../../shared'
import {
  GascitySupervisorClient,
  type SupervisorUnavailableReason,
} from './supervisor-client'
import { supervisorCityNameForRoot } from './supervisor-endpoint'
import type { SupervisorConnect } from './supervisor-transport'
import type { CityInfo } from './generated-supervisor-api'

/** How long a city list stands before it is read again. */
const CITY_CACHE_MS = 30_000

/** What the caller needs to speak to one session. */
export interface SupervisorSessionAddress {
  readonly client: GascitySupervisorClient
  /** The supervisor's own name for the city, for its path parameters. */
  readonly cityName: string
}

export interface SupervisorAccessTarget {
  readonly hostId: HostId
  /** The city root the projection recorded for the session's host, if any. */
  readonly cityRoot?: HostPath
}

/** Every reason the supervisor itself can give, plus the one this layer adds. */
export type SupervisorAddressReason = SupervisorUnavailableReason | 'city-unknown'

export type SupervisorAddressResult =
  | { readonly ok: true; readonly value: SupervisorSessionAddress }
  | {
      readonly ok: false
      readonly failure: { readonly reason: SupervisorAddressReason }
    }

export interface SupervisorAccessOptions {
  /**
   * A loopback channel for a host that is connected right now, or nothing.
   * Returning nothing is how a disconnected host stays unreachable rather than
   * becoming a connection attempt.
   */
  readonly connectFor: (hostId: HostId) => SupervisorConnect | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** The narrow surface a detail-scoped consumer needs; the rest is construction. */
export interface SupervisorAccess {
  address(target: SupervisorAccessTarget): Promise<SupervisorAddressResult>
}

interface CachedCities {
  readonly at: number
  readonly cities: readonly CityInfo[]
}

export class GascitySupervisorAccess implements SupervisorAccess {
  private readonly clients = new Map<HostId, GascitySupervisorClient>()
  private readonly cities = new Map<HostId, CachedCities>()
  private readonly now: () => number

  constructor(private readonly options: SupervisorAccessOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  async address(target: SupervisorAccessTarget): Promise<SupervisorAddressResult> {
    const client = this.client(target.hostId)
    if (client === undefined) return { ok: false, failure: { reason: 'unreachable' } }
    if (!client.configured) return { ok: false, failure: { reason: 'disabled' } }
    const cities = await this.cityList(client)
    if (!cities.ok) return cities
    const cityName = this.cityName(cities.value, target.cityRoot)
    if (cityName === undefined) return { ok: false, failure: { reason: 'city-unknown' } }
    return { ok: true, value: { client, cityName } }
  }

  /** Drops what was cached for a host, or for every host. */
  forget(hostId?: HostId): void {
    if (hostId === undefined) {
      this.clients.clear()
      this.cities.clear()
      return
    }
    this.clients.delete(hostId)
    this.cities.delete(hostId)
  }

  private client(hostId: HostId): GascitySupervisorClient | undefined {
    const connect = this.options.connectFor(hostId)
    // No channel means no client, and the cached one goes too: it holds a
    // connect bound to a host that is no longer there.
    if (connect === undefined) {
      this.forget(hostId)
      return undefined
    }
    const current = this.clients.get(hostId)
    if (current !== undefined) return current
    const created = new GascitySupervisorClient({
      hostId,
      connect,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs }),
    })
    this.clients.set(hostId, created)
    return created
  }

  private async cityList(client: GascitySupervisorClient): Promise<
    | { readonly ok: true; readonly value: readonly CityInfo[] }
    | {
        readonly ok: false
        readonly failure: { readonly reason: SupervisorAddressReason }
      }
  > {
    const cached = this.cities.get(client.hostId)
    if (cached !== undefined && this.now() - cached.at < CITY_CACHE_MS) {
      return { ok: true, value: cached.cities }
    }
    const result = await client.cities()
    // A failed read is not cached: the next selection asks again rather than
    // repeating a stale verdict for the cache's lifetime.
    if (!result.ok) return { ok: false, failure: { reason: result.failure.reason } }
    this.cities.set(client.hostId, { at: this.now(), cities: result.value })
    return { ok: true, value: result.value }
  }

  /**
   * The city the projection named, or the only one the supervisor serves. The
   * fallback is not an inference about which city a session belongs to: with a
   * single city there is nothing to choose between.
   */
  private cityName(
    cities: readonly CityInfo[],
    cityRoot: HostPath | undefined,
  ): string | undefined {
    if (cityRoot !== undefined) return supervisorCityNameForRoot(cities, cityRoot.path)
    return cities.length === 1 ? cities[0]?.name : undefined
  }
}
