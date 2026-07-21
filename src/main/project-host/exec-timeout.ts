/**
 * A budget for a buffered `exec`.
 *
 * Buffered exec has no other escape hatch. `ExecOptions.signal` covers the
 * caller who *knows* it wants to stop; nothing covers the command that simply
 * never returns. On the SSH host that matters more than it looks: the
 * background lane is one slot wide, so a single wedged command freezes every
 * poll behind it for the life of the process, with no error to show for it.
 *
 * This is the trust boundary where a timeout belongs, and it propagates a real
 * error rather than a silent empty result.
 */
export class ExecTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(command: string, timeoutMs: number) {
    super(`${command} exceeded its ${timeoutMs}ms timeout`)
    this.name = 'ExecTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export function isExecTimeout(reason: unknown): reason is ExecTimeoutError {
  return reason instanceof ExecTimeoutError
}

/**
 * The signal an exec should actually watch: the caller's own, the timeout, or
 * both. `expired()` distinguishes the two after the fact — an abort raised by
 * the caller is a cancellation, not a timeout, and the two must not be reported
 * the same way.
 */
export interface ExecDeadline {
  readonly signal: AbortSignal | undefined
  readonly expired: () => boolean
  readonly dispose: () => void
}

const NO_DEADLINE: ExecDeadline = {
  signal: undefined,
  expired: () => false,
  dispose: () => {},
}

/**
 * Compose the caller's signal with a timeout. Returns the caller's signal
 * untouched when no timeout is configured, so the common path arms no timer.
 */
export function execDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ExecDeadline {
  if (timeoutMs === undefined) {
    return signal === undefined ? NO_DEADLINE : { ...NO_DEADLINE, signal }
  }
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  // Unref so a pending budget cannot by itself keep the process alive.
  timer.unref?.()
  const forward = (): void => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted === true) controller.abort()
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    },
  }
}
