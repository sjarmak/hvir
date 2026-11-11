type TimerHandle = ReturnType<typeof setTimeout>

const DEFAULT_COST_FACTOR = 5
const DEFAULT_MAX_INTERVAL_MS = 30_000

export interface VisibilityRefreshOptions {
  readonly onRefresh: () => void | Promise<unknown>
  readonly intervalMs: number
  readonly costFactor?: number
  readonly maxIntervalMs?: number
  readonly schedule?: (callback: () => void, ms: number) => TimerHandle
  readonly cancel?: (handle: TimerHandle) => void
  readonly now?: () => number
}

export interface VisibilityRefresh {
  setVisible(visible: boolean): void
  focus(): void
  request(delayMs?: number): void
  dispose(): void
}

export function createVisibilityRefresh(
  options: VisibilityRefreshOptions,
): VisibilityRefresh {
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const now = options.now ?? (() => Date.now())
  const costFactor = options.costFactor ?? DEFAULT_COST_FACTOR
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS
  let visible = false
  let disposed = false
  let timer: TimerHandle | undefined
  let running = false
  let pending = false

  const stopPolling = (): void => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }
  const nextDelay = (elapsedMs: number): number =>
    Math.min(maxIntervalMs, Math.max(options.intervalMs, elapsedMs * costFactor))
  const cycle = async (): Promise<void> => {
    if (disposed || !visible) return
    if (running) {
      pending = true
      return
    }
    stopPolling()
    running = true
    const startedAt = now()
    try {
      await options.onRefresh()
    } catch (reason) {
      console.error('[visibility-refresh] refresh failed', reason)
    }
    running = false
    if (disposed || !visible) return
    if (pending) {
      pending = false
      void cycle()
      return
    }
    if (options.intervalMs <= 0) return
    if (timer === undefined)
      timer = schedule(() => void cycle(), nextDelay(now() - startedAt))
  }
  const request = (delayMs = 0): void => {
    if (disposed || !visible) return
    stopPolling()
    if (delayMs > 0) timer = schedule(() => void cycle(), delayMs)
    else void cycle()
  }

  return {
    request,
    setVisible(next): void {
      if (disposed || next === visible) return
      visible = next
      if (visible) void cycle()
      else {
        pending = false
        stopPolling()
      }
    },
    focus(): void {
      request()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      visible = false
      stopPolling()
    },
  }
}
