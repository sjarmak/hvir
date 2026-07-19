import { hostPathEquals, type GasCitySession, type HostId, type HostPath } from '../../shared'

/**
 * The live half of a crew snapshot, cached just long enough to be shared.
 *
 * `gc session list` ignores `--rig` and returns every session in the city, so
 * every workspace in one city asks for the identical payload — and on a real
 * city that read takes about three seconds. Without this, switching between tabs
 * pays it once per tab, which is the whole reported symptom. The TTL is
 * deliberately far shorter than the context cache's: this is the half that
 * actually changes, and a crew view lagging reality by seconds is a different
 * kind of wrong from a slow one.
 */
export const SESSION_TTL_MS = 3_000

interface CacheEntry {
  readonly loadedAt: number
  readonly value: Promise<readonly GasCitySession[]>
  /** Which city the read described, once a caller has resolved it. */
  city?: HostPath
}

export interface GasCitySessionCacheOptions {
  readonly load: (root: HostPath) => Promise<readonly GasCitySession[]>
  readonly ttlMs?: number
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Caches the parsed session list per host and shares one in-flight read between
 * concurrent callers. A failed read is evicted rather than cached, so a
 * transient `gc` failure cannot pin an empty crew in place for the window.
 *
 * **The key is the host, not the city**, because the city cannot be known before
 * the read: gc resolves it from the working directory through its machine-wide
 * registry, and hvir learns it only from `gc rig list`, which is the read this
 * cache exists to avoid waiting on. One gc installation per host serving one
 * city is the normal case and the key is right for it. {@link attribute} closes
 * the gap for the abnormal one: once a caller knows which city a cached read
 * actually described, a later caller expecting a different city misses instead
 * of silently being served another city's crew.
 */
export class GasCitySessionCache {
  private readonly entries = new Map<HostId, CacheEntry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly options: GasCitySessionCacheOptions) {
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** `city` is the caller's expectation, when it already has one. */
  get(
    root: HostPath,
    city: HostPath | undefined,
  ): Promise<readonly GasCitySession[]> {
    const cached = this.entries.get(root.hostId)
    if (cached && this.now() - cached.loadedAt < this.ttlMs && describes(cached, city)) {
      return cached.value
    }

    const value = this.options.load(root)
    const entry: CacheEntry = { loadedAt: this.now(), value, ...(city ? { city } : {}) }
    this.entries.set(root.hostId, entry)
    void value.catch(() => {
      if (this.entries.get(root.hostId)?.value === value) this.entries.delete(root.hostId)
    })
    return value
  }

  /**
   * Record which city a host's cached read described. A read attributed to two
   * different cities is dropped, so the mistake costs one repeat read rather
   * than showing the wrong crew until the entry ages out.
   */
  attribute(hostId: HostId, city: HostPath | undefined): void {
    const entry = this.entries.get(hostId)
    if (!entry || city === undefined) return
    if (entry.city === undefined) entry.city = city
    else if (!hostPathEquals(entry.city, city)) this.entries.delete(hostId)
  }

  /** Drop everything — the manual-refresh escape hatch. */
  invalidate(): void {
    this.entries.clear()
  }
}

function describes(entry: CacheEntry, city: HostPath | undefined): boolean {
  if (city === undefined || entry.city === undefined) return true
  return hostPathEquals(entry.city, city)
}
