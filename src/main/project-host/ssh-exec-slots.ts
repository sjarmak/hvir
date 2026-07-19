import type { ExecLane } from './project-host'

/**
 * How many buffered commands one host runs at once. Small on purpose: every one
 * costs an SSH channel, and the pool is shared with terminals and tunnels.
 */
export const SSH_DEFAULT_MAX_CONCURRENT_EXECS = 4
/** Hard ceiling on the requested budget, so a bad config cannot exhaust the pool. */
export const SSH_MAX_CONCURRENT_EXECS = 16
/**
 * How much of that budget background polls may hold at once.
 *
 * Remote CLIs behind a poll are not always fast — `gc session list` on a real
 * city takes about three seconds, against tens of milliseconds for `bd` or
 * `git status` — and the budget is shared by every subsystem. One slot keeps a
 * slow poll from starving the work a user is actually waiting on.
 */
export const SSH_MAX_BACKGROUND_EXECS = 1

export interface ExecSlotsOptions {
  readonly maxConcurrent?: number
  /** True once the owning host is disposed; queued waiters are then rejected. */
  readonly disposed: () => boolean
}

interface ExecWaiter {
  readonly lane: ExecLane
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  abort?: () => void
}

/**
 * The buffered-exec admission budget for one host, split into two lanes.
 *
 * A single counter is not enough once commands differ in cost by two orders of
 * magnitude. A three-second poll repeated on a four-second timer holds a plain
 * semaphore most of the time, and the git discovery a user is waiting on after a
 * workspace switch queues behind it — which reads as the whole app being slow,
 * not as one panel being slow. Reserving the background lane at one slot bounds
 * that: a slow poll costs its own latency and nothing else's.
 */
export class ExecSlots {
  private readonly maxConcurrent: number
  private active = 0
  private activeBackground = 0
  private readonly waiters: ExecWaiter[] = []

  constructor(private readonly options: ExecSlotsOptions) {
    const requested = options.maxConcurrent ?? SSH_DEFAULT_MAX_CONCURRENT_EXECS
    this.maxConcurrent = Math.max(
      1,
      Math.min(
        SSH_MAX_CONCURRENT_EXECS,
        Number.isFinite(requested)
          ? Math.floor(requested)
          : SSH_DEFAULT_MAX_CONCURRENT_EXECS,
      ),
    )
  }

  /** Resolves with the release callback once this lane has room. */
  acquire(lane: ExecLane, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.options.disposed()) return Promise.reject(disposedError())
    if (this.canAdmit(lane)) return Promise.resolve(this.admit(lane))
    return new Promise((resolve, reject) => {
      const waiter: ExecWaiter = { lane, resolve, reject, signal }
      if (signal) {
        const abort = (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortError())
        }
        waiter.abort = abort
        signal.addEventListener('abort', abort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  /** Reject everything still queued — the host is going away. */
  cancelAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
      waiter.reject(error)
    }
  }

  private canAdmit(lane: ExecLane): boolean {
    if (this.active >= this.maxConcurrent) return false
    return lane !== 'background' || this.activeBackground < SSH_MAX_BACKGROUND_EXECS
  }

  private admit(lane: ExecLane): () => void {
    this.active++
    if (lane === 'background') this.activeBackground++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      if (lane === 'background') {
        this.activeBackground = Math.max(0, this.activeBackground - 1)
      }
      this.admitNext()
    }
  }

  /**
   * Hand the freed slot to the first waiter that can take it. A queued
   * background exec is passed over while the background lane is still occupied,
   * rather than holding up the interactive work behind it.
   */
  private admitNext(): void {
    for (;;) {
      const index = this.waiters.findIndex(
        (waiter) =>
          this.options.disposed() || waiter.signal?.aborted || this.canAdmit(waiter.lane),
      )
      if (index < 0) return
      const [waiter] = this.waiters.splice(index, 1)
      if (!waiter) return
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
      if (this.options.disposed()) {
        waiter.reject(new Error('SSH connection cancelled'))
        continue
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError())
        continue
      }
      waiter.resolve(this.admit(waiter.lane))
      return
    }
  }
}

function disposedError(): Error {
  return new Error('SSH host is disconnected; reconnect explicitly before retrying')
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
