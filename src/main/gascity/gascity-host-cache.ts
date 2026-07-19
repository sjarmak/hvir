import { hostPathEquals, type HostId, type HostPath } from '../../shared'

/**
 * How long a read of the live session list is shared.
 *
 * Short on purpose: this is the half that actually changes, and a crew view
 * lagging reality by seconds is a different kind of wrong from a slow one.
 */
export const SESSION_TTL_MS = 3_000

interface CacheEntry<T> {
  readonly loadedAt: number
  readonly value: Promise<T>
  /** Which city the read described, once a caller has resolved it. */
  city?: HostPath
}

export interface HostReadCacheOptions<T> {
  readonly load: (root: HostPath) => Promise<T>
  readonly ttlMs: number
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * One `gc` read per host, shared by every workspace on it.
 *
 * All three reads hvir makes are city-wide: `gc session list` ignores `--rig`,
 * `gc rig list` describes the whole city, and `gc config show` is the city's
 * composed config. Only which rig a workspace maps to differs, and that is a
 * pure function of the rig list. So a workspace switch should cost no `gc` at
 * all — without this it re-paid every read, and on a real city each takes
 * seconds.
 *
 * **The key is the host, not the city**, because the city cannot be known
 * before the reads: gc resolves it from the working directory through its
 * machine-wide registry, and hvir learns it only from `gc rig list`, which is
 * one of the reads being cached. One gc installation per host serving one city
 * is the normal case and the key is right for it. {@link attribute} closes the
 * gap for the abnormal one: once a caller knows which city a cached read
 * actually described, a later caller expecting a different city misses instead
 * of silently being served another city's data.
 *
 * A failed read is evicted rather than cached, so a transient `gc` failure
 * cannot pin degraded data in place for the whole window.
 */
export class HostReadCache<T> {
  private readonly entries = new Map<HostId, CacheEntry<T>>()
  private readonly now: () => number

  constructor(private readonly options: HostReadCacheOptions<T>) {
    this.now = options.now ?? (() => Date.now())
  }

  /** `city` is the caller's expectation, when it already has one. */
  get(root: HostPath, city?: HostPath): Promise<T> {
    const cached = this.entries.get(root.hostId)
    if (
      cached &&
      this.now() - cached.loadedAt < this.options.ttlMs &&
      describes(cached, city)
    ) {
      return cached.value
    }

    const value = this.options.load(root)
    const entry: CacheEntry<T> = {
      loadedAt: this.now(),
      value,
      ...(city ? { city } : {}),
    }
    this.entries.set(root.hostId, entry)
    void value.catch(() => {
      if (this.entries.get(root.hostId)?.value === value) this.entries.delete(root.hostId)
    })
    return value
  }

  /**
   * Record which city a host's cached read described. A read attributed to two
   * different cities is dropped, so the mistake costs one repeat read rather
   * than showing the wrong data until the entry ages out.
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

function describes<T>(entry: CacheEntry<T>, city: HostPath | undefined): boolean {
  if (city === undefined || entry.city === undefined) return true
  return hostPathEquals(entry.city, city)
}
