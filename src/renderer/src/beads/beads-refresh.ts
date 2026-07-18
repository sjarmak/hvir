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
 * The controller is framework-agnostic (no React) so its visibility/polling
 * rules are unit-testable. Timer functions are injectable for the same reason;
 * they default to the globals.
 */

export interface VisibilityRefreshOptions {
  /** Runs a refresh. Called on becoming visible, on {@link VisibilityRefresh.focus}, and each poll tick. */
  readonly onRefresh: () => void
  /** Poll period while visible. */
  readonly intervalMs: number
  /** Injectable for tests; defaults to `setInterval`. */
  readonly schedule?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Injectable for tests; defaults to `clearInterval`. */
  readonly cancel?: (handle: ReturnType<typeof setInterval>) => void
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
  const schedule = options.schedule ?? ((cb, ms) => setInterval(cb, ms))
  const cancel = options.cancel ?? ((handle) => clearInterval(handle))

  let visible = false
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const stopPolling = (): void => {
    if (timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
  }

  return {
    setVisible(next: boolean): void {
      if (disposed || next === visible) return
      visible = next
      if (visible) {
        options.onRefresh()
        // Guard against a zero/negative interval degenerating into a busy loop.
        if (options.intervalMs > 0) {
          timer = schedule(() => options.onRefresh(), options.intervalMs)
        }
      } else {
        stopPolling()
      }
    },
    focus(): void {
      if (disposed || !visible) return
      options.onRefresh()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      visible = false
      stopPolling()
    },
  }
}
