import type {
  CompanionConfigSave,
  CompanionConfigView,
  CompanionListenerStatus,
} from '../../shared'
import type { Disposer } from '../project-host'
import type { CompanionAuthPort } from './companion-auth'
import type { CompanionConfigStore } from './companion-config-store'
import { CompanionPairing } from './companion-pairing'

/** What the IPC registrar needs from the Companion settings owner. */
export interface CompanionSettingsPort {
  view(): CompanionConfigView
  save(request: CompanionConfigSave): Promise<CompanionConfigView>
  issuePairing(): CompanionConfigView
  revokePairing(): Promise<CompanionConfigView>
  observe(listener: (view: CompanionConfigView) => void): Disposer
}

export interface CompanionSettingsOptions {
  readonly store: CompanionConfigStore
  readonly now?: () => number
  /** A credential write that failed after the token was already handed out. */
  readonly onCredentialWriteFailed?: (error: unknown) => void
}

export const COMPANION_TOKEN_NOT_STORED =
  'The push token was not stored: this system offers no encrypted secret storage. The sink URL was saved.'

/**
 * The Settings-facing owner of the Companion configuration (ADR-049).
 *
 * It composes the store and the pairing into one view, tells every observer
 * when that view changes, and carries the listener status a later owner sets.
 * Nothing here starts the listener: `status` stays `{ listening: false }`
 * until the composition root drives it through `setStatus`.
 */
export class CompanionSettings implements CompanionSettingsPort {
  readonly auth: CompanionAuthPort
  private readonly pairing: CompanionPairing
  private readonly store: CompanionConfigStore
  private status: CompanionListenerStatus = { listening: false }
  private readonly observers = new Set<(view: CompanionConfigView) => void>()
  private readonly revocationListeners = new Set<() => void>()

  constructor(options: CompanionSettingsOptions) {
    this.store = options.store
    this.pairing = new CompanionPairing({
      credential: {
        current: () => this.store.config().credential,
        store: (record) => {
          this.store.setCredential(record).catch((error: unknown) => {
            options.onCredentialWriteFailed?.(error)
          })
        },
        clear: () => undefined,
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      onRevoked: () => {
        for (const listener of this.revocationListeners) listener()
      },
      onChange: () => this.notify(),
    })
    this.auth = this.pairing
  }

  view(): CompanionConfigView {
    const config = this.store.config()
    const pairing = this.pairing.outstandingCode()
    return {
      enabled: config.enabled,
      port: config.port,
      paired: this.pairing.paired(),
      ...(pairing === undefined ? {} : { pairing }),
      push:
        config.push === undefined
          ? undefined
          : {
              url: config.push.url,
              tokenConfigured: config.push.tokenCiphertext !== undefined,
            },
      status: this.status,
    }
  }

  async save(request: CompanionConfigSave): Promise<CompanionConfigView> {
    const result = await this.store.save(request)
    this.notify()
    if (result.outcome === 'token-rejected') throw new Error(COMPANION_TOKEN_NOT_STORED)
    return this.view()
  }

  issuePairing(): CompanionConfigView {
    this.pairing.issue()
    return this.view()
  }

  async revokePairing(): Promise<CompanionConfigView> {
    await this.store.clearCredential()
    this.pairing.revoke()
    return this.view()
  }

  observe(listener: (view: CompanionConfigView) => void): Disposer {
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }

  /** Runs when the pairing is revoked, so open Companion pages can be closed. */
  onRevoked(listener: () => void): Disposer {
    this.revocationListeners.add(listener)
    return () => {
      this.revocationListeners.delete(listener)
    }
  }

  /** The listener owner reports what it is doing; the view and observers follow. */
  setStatus(status: CompanionListenerStatus): void {
    this.status = status
    this.notify()
  }

  flush(): Promise<void> {
    return this.store.flush()
  }

  /**
   * The push token in the clear, for the sink that sends with it. Main only:
   * the view carries `tokenConfigured` and nothing else about the token.
   */
  pushToken(): string | undefined {
    return this.store.pushToken()
  }

  private notify(): void {
    const view = this.view()
    for (const listener of this.observers) listener(view)
  }
}
