/**
 * Visibility-driven refresh for the Beads panel.
 *
 * The `.beads/` directory watcher is not a reliable change signal for a shared
 * Dolt server: mutations land in the central server and may never touch the
 * rig's `.beads/` directory. So the panel refreshes on an explicit signal —
 * becoming visible, regaining focus, or a manual click — and, while visible,
 * polls on a bounded interval. Polling stops the moment the panel is hidden or
 * disposed so a background panel never drives `bd` on the host.
 *
 * **The period is a floor, not a schedule.** What a refresh costs is a property
 * of the host, not of this code: the same `gc session list` returns in
 * milliseconds locally and in about three seconds against a real city over SSH.
 * A fixed interval shorter than the refresh it triggers leaves the reader
 * permanently mid-read, so each poll waits a multiple of what the last one
 * actually took. A fast host keeps the configured period; a slow one backs off
 * on its own, without a constant here having to guess which it is.
 *
 * The controller is framework-agnostic (no React) so its visibility/polling
 * rules are unit-testable. Timers and the clock are injectable for the same
 * reason; they default to the globals.
 */

type TimerHandle = ReturnType<typeof setTimeout>

/** Share of the poll period a refresh may spend running before it backs off. */
const DEFAULT_COST_FACTOR = 5
/** However slow the host, a visible panel still refreshes this often. */
const DEFAULT_MAX_INTERVAL_MS = 30_000

export interface VisibilityRefreshOptions {
  /**
   * Runs a refresh. Called on becoming visible, on {@link VisibilityRefresh.focus},
   * and each poll tick. A returned promise is awaited, and how long it takes
   * sets the floor for the next poll.
   */
  readonly onRefresh: () => void | Promise<unknown>
  /** Minimum poll period while visible. */
  readonly intervalMs: number
  /** Multiple of the last refresh's own cost the next poll waits at least. */
  readonly costFactor?: number
  /** Ceiling on the backed-off period. */
  readonly maxIntervalMs?: number
  /** Injectable for tests; defaults to `setTimeout`. */
  readonly schedule?: (callback: () => void, ms: number) => TimerHandle
  /** Injectable for tests; defaults to `clearTimeout`. */
  readonly cancel?: (handle: TimerHandle) => void
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

export interface VisibilityRefresh {
  /** Show or hide the panel. Becoming visible refreshes immediately and starts polling; hiding stops polling. */
  setVisible(visible: boolean): void
  /** A focus/foreground signal. Refreshes only when currently visible. */
  focus(): void
  /** Stop polling permanently. Every method is a no-op afterwards. */
  dispose(): void
}

export function createVisibilityRefresh(
  options: VisibilityRefreshOptions,
): VisibilityRefresh {
  const schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const now = options.now ?? (() => Date.now())
  const costFactor = options.costFactor ?? DEFAULT_COST_FACTOR
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS

  let visible = false
  let disposed = false
  let timer: TimerHandle | undefined

  const stopPolling = (): void => {
    if (timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
  }

  const nextDelay = (elapsedMs: number): number =>
    Math.min(maxIntervalMs, Math.max(options.intervalMs, elapsedMs * costFactor))

  // Refresh, then schedule the next one from what this one cost. Chained rather
  // than a fixed interval so a refresh can never overlap its own successor.
  const cycle = async (): Promise<void> => {
    const startedAt = now()
    try {
      await options.onRefresh()
    } catch {
      // A refresh reports its own failures; the poll must outlive them.
    }
    if (disposed || !visible) return
    // A non-positive period means "refresh on signals only", never on a timer.
    if (options.intervalMs <= 0) return
    timer = schedule(() => void cycle(), nextDelay(now() - startedAt))
  }

  return {
    setVisible(next: boolean): void {
      if (disposed || next === visible) return
      visible = next
      if (visible) void cycle()
      else stopPolling()
    },
    focus(): void {
      if (disposed || !visible) return
      void options.onRefresh()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      visible = false
      stopPolling()
    },
  }
}
