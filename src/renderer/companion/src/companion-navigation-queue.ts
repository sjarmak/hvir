/**
 * The read-back reports of one mirror, on their way to the desktop in order
 * (ADR-055, ADR-056). A finger over a program that owns its history produces a
 * report on every move, and the page used to post each as its own request: the
 * browser opens them in parallel, the listener answers them in whatever order
 * they land, and a program paged up and then down could receive the down first.
 * Here one request is in flight per mirror at a time, and every report made
 * while it is out joins the next, so the desktop receives one ordered write per
 * round trip rather than a race of them. The wire admits a batch of the closed
 * set, bounded; a batch longer than the bound is cut at a token boundary, which
 * is where the next ESC starts.
 *
 * A refusal drops what was waiting: the reports were for the gesture that was
 * refused, and the next gesture asks again on its own. A new mirror drops it
 * too, since the reports were for the one before.
 */
import { MAX_COMPANION_INPUT_CHARS, TERMINAL_READ_BACK_TOKEN_START } from '../../../shared'

/** Posts one batch; answers whether the desktop accepted it, so the rest may follow. */
export type CompanionNavigationSender = (batch: string) => Promise<boolean>

export class CompanionNavigationQueue {
  private key?: string
  private pending = ''
  private send?: CompanionNavigationSender
  private draining = false

  constructor(private readonly limit: number = MAX_COMPANION_INPUT_CHARS) {}

  /** What is waiting for the next round trip, for the mirror named. */
  waiting(key: string): string {
    return this.key === key ? this.pending : ''
  }

  push(key: string, data: string, send: CompanionNavigationSender): void {
    if (this.key !== key) {
      this.key = key
      this.pending = ''
    }
    this.send = send
    this.pending += data
    if (!this.draining) void this.drain()
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.pending.length > 0 && this.send !== undefined) {
        const key = this.key
        const accepted = await this.send(this.take())
        if (!accepted && this.key === key) this.pending = ''
      }
    } finally {
      this.draining = false
    }
  }

  /** As much of what is waiting as one request carries, cut only between tokens. */
  private take(): string {
    const pending = this.pending
    if (pending.length <= this.limit) {
      this.pending = ''
      return pending
    }
    const cut = pending.lastIndexOf(TERMINAL_READ_BACK_TOKEN_START, this.limit)
    const batch = cut > 0 ? pending.slice(0, cut) : pending
    this.pending = pending.slice(batch.length)
    return batch
  }
}
