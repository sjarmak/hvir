/**
 * Keeps the loopback listener where Settings says it should be (ADR-049):
 * open while enabled on the saved port, closed otherwise, reopened when the
 * port changes. Every outcome lands in `settings.setStatus`, so the Settings
 * view shows the bound state and never a wish. A port that cannot be bound is
 * a status plus a diagnostic; nothing here rejects.
 */
import type { CompanionListenerStatus } from '../../shared'
import type { CompanionServer } from './companion-server'

export interface CompanionListenerTarget {
  readonly enabled: boolean
  readonly port: number
}

export interface CompanionListenerFailure {
  readonly kind: 'listener-failed'
  readonly port: number
  readonly message: string
}

export interface CompanionListenerOptions {
  readonly server: Pick<CompanionServer, 'open' | 'close' | 'listening' | 'port'>
  readonly setStatus: (status: CompanionListenerStatus) => void
  readonly onFailure?: (failure: CompanionListenerFailure) => void
}

export class CompanionListener {
  private applied: CompanionListenerTarget | undefined
  private openedWith: number | undefined
  private disposed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: CompanionListenerOptions) {}

  /** Reconciles the listener to `target`; calls serialize and never reject. */
  follow(target: CompanionListenerTarget): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile(target))
    return this.queue
  }

  /** Closes the listener for good; a later follow is a no-op. */
  dispose(): Promise<void> {
    this.queue = this.queue.then(async () => {
      this.disposed = true
      await this.closeIfOpen()
    })
    return this.queue
  }

  private async reconcile(target: CompanionListenerTarget): Promise<void> {
    if (this.disposed) return
    if (this.applied?.enabled === target.enabled && this.applied.port === target.port)
      return
    this.applied = target
    const portChanged = this.openedWith !== undefined && this.openedWith !== target.port
    if (!target.enabled || portChanged) await this.closeIfOpen()
    if (target.enabled && !this.options.server.listening) await this.openOn(target.port)
  }

  private async closeIfOpen(): Promise<void> {
    if (this.openedWith === undefined) return
    this.openedWith = undefined
    await this.options.server.close()
    this.options.setStatus({ listening: false })
  }

  private async openOn(port: number): Promise<void> {
    try {
      await this.options.server.open(port)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.setStatus({ listening: false, error: message })
      this.options.onFailure?.({ kind: 'listener-failed', port, message })
      return
    }
    this.openedWith = port
    const bound = this.options.server.port
    this.options.setStatus(
      bound === undefined ? { listening: true } : { listening: true, port: bound },
    )
  }
}
