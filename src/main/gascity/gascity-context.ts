import { hostPathEquals, type HostPath } from '../../shared'
import type { GasCityResolvedConfig } from './gascity-config'

/**
 * The slow half of a crew snapshot, cached.
 *
 * A crew refresh needs two very different kinds of data. The session list is
 * live and has to be re-read every poll. The city's shape — its rigs, where the
 * city root is, the resolved config — changes when someone edits config, which
 * is to say almost never on the timescale of a 4-second poll.
 *
 * Reading both every tick meant three `gc` invocations through a login shell
 * plus a stat per rig, and `gc config show` re-composes the entire city (every
 * include, pack, patch, and override) before emitting a TOML document that then
 * has to be parsed. On a real city that is enough work, often enough, to make
 * the whole app feel slow. Caching this half turns a steady-state poll into a
 * single `gc session list`.
 */
export interface GasCityContext {
  /** Rig the workspace maps to, when `gc rig list` resolved one. */
  readonly rigName?: string
  readonly cityRoot?: HostPath
  readonly hqRigName?: string
  readonly config: GasCityResolvedConfig
}

/** Long enough to skip most polls, short enough that a config edit lands soon. */
export const CONTEXT_TTL_MS = 60_000

/** One entry per workspace the user has visited; a session touches very few. */
const MAX_ENTRIES = 8

interface CacheEntry {
  readonly loadedAt: number
  readonly value: Promise<GasCityContext>
  /** Set once `value` settles, so {@link GasCityContextCache.peek} can read it. */
  resolved?: GasCityContext
}

export interface GasCityContextCacheOptions {
  readonly load: (root: HostPath, withConfig: boolean) => Promise<GasCityContext>
  readonly ttlMs?: number
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Caches {@link GasCityContext} per workspace root, and shares one in-flight
 * load between concurrent callers so a slow `gc config show` is never started
 * twice. A failed load is evicted rather than cached, so a transient `gc`
 * failure does not pin a degraded crew in place for the whole TTL.
 */
export class GasCityContextCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly options: GasCityContextCacheOptions) {
    this.ttlMs = options.ttlMs ?? CONTEXT_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  get(root: HostPath, withConfig: boolean): Promise<GasCityContext> {
    const key = cacheKey(root, withConfig)
    const cached = this.entries.get(key)
    if (cached && this.now() - cached.loadedAt < this.ttlMs) return cached.value

    const value = this.options.load(root, withConfig)
    const entry: CacheEntry = { loadedAt: this.now(), value }
    this.entries.set(key, entry)
    void value.then(
      (context) => {
        entry.resolved = context
      },
      () => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key)
      },
    )
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    return value
  }

  /**
   * What is already known about this workspace's city, without starting a load.
   *
   * Callers that need the city root to decide *how* to fetch something cannot
   * await the context first without inverting the order the crew read depends
   * on. Peeking answers "do we already know" and returns nothing while a load is
   * in flight, so an unknown city degrades a caller's behaviour rather than
   * stalling it.
   */
  peek(root: HostPath): GasCityContext | undefined {
    for (const withConfig of [true, false]) {
      const entry = this.entries.get(cacheKey(root, withConfig))
      if (entry && this.now() - entry.loadedAt < this.ttlMs && entry.resolved) {
        return entry.resolved
      }
    }
    return undefined
  }

  /** Drop everything for one workspace — the manual-refresh escape hatch. */
  invalidate(root: HostPath): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${root.hostId}:${root.path}:`)) this.entries.delete(key)
    }
  }
}

function cacheKey(root: HostPath, withConfig: boolean): string {
  return `${root.hostId}:${root.path}:${withConfig ? 'config' : 'bare'}`
}

/** Whether a resolved context says this workspace is the city itself. */
export function isCityWorkspace(context: GasCityContext, root: HostPath): boolean {
  return context.cityRoot !== undefined && hostPathEquals(context.cityRoot, root)
}
