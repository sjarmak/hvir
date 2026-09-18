import {
  COMPANION_DEFAULT_PORT,
  isCompanionPort,
  isCompanionPushUrl,
  type CompanionConfigSave,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'

const FILE_VERSION = 1

export interface CompanionCredentialRecord {
  /** sha256 of the base64url token, hex encoded. The token itself is never kept. */
  readonly hash: string
  readonly issuedAt: number
}

export interface CompanionStoredPush {
  readonly url: string
  /** The push token through the OS cipher, base64 encoded. */
  readonly tokenCiphertext?: string
}

export interface CompanionStoredConfig {
  readonly enabled: boolean
  readonly port: number
  readonly credential?: CompanionCredentialRecord
  readonly push?: CompanionStoredPush
}

/** The OS-backed secret cipher. Electron's safeStorage satisfies it directly. */
export interface CompanionSecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** The one file the store reads and writes, through the host like every other state file. */
export type CompanionStoreFile = Pick<ProjectHost, 'readTextFile' | 'writeFile'>

export type CompanionConfigDiagnostic =
  | { readonly kind: 'unreadable'; readonly message: string }
  | { readonly kind: 'version-mismatch'; readonly found: unknown }
  | { readonly kind: 'token-undecryptable'; readonly message: string }

export type CompanionConfigSaveOutcome =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'token-rejected'; readonly reason: 'encryption-unavailable' }

export interface CompanionConfigStoreOptions {
  readonly secrets: CompanionSecretStorage
  readonly onDiagnostic?: (diagnostic: CompanionConfigDiagnostic) => void
}

const DEFAULTS: CompanionStoredConfig = { enabled: false, port: COMPANION_DEFAULT_PORT }

/**
 * `companion.json` under the application user data root (ADR-049).
 *
 * Settings, the credential hash and the push sink live in one file; the push
 * token is stored only through the OS cipher and only when that cipher is
 * available, otherwise the save keeps the url and says so explicitly.
 */
export class CompanionConfigStore {
  private state: CompanionStoredConfig
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(
    private readonly host: CompanionStoreFile,
    private readonly file: HostPath,
    initial: CompanionStoredConfig,
    private readonly options: CompanionConfigStoreOptions,
  ) {
    this.state = initial
  }

  static async load(
    host: CompanionStoreFile,
    file: HostPath,
    options: CompanionConfigStoreOptions,
  ): Promise<CompanionConfigStore> {
    let text: string | undefined
    try {
      text = await host.readTextFile(file)
    } catch (error) {
      if (!isMissingFile(error)) options.onDiagnostic?.(unreadable(error))
      return new CompanionConfigStore(host, file, DEFAULTS, options)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      options.onDiagnostic?.(unreadable(error))
      return new CompanionConfigStore(host, file, DEFAULTS, options)
    }
    if (!isRecord(parsed) || parsed['version'] !== FILE_VERSION) {
      options.onDiagnostic?.({
        kind: 'version-mismatch',
        found: isRecord(parsed) ? parsed['version'] : undefined,
      })
      return new CompanionConfigStore(host, file, DEFAULTS, options)
    }
    return new CompanionConfigStore(host, file, parseStored(parsed), options)
  }

  /** The stored configuration; the push token appears only as ciphertext. */
  config(): CompanionStoredConfig {
    return this.state
  }

  /** The push token in the clear, for the sink that sends with it; never for a renderer. */
  pushToken(): string | undefined {
    const ciphertext = this.state.push?.tokenCiphertext
    if (ciphertext === undefined) return undefined
    try {
      return this.options.secrets.decryptString(Buffer.from(ciphertext, 'base64'))
    } catch (error) {
      this.options.onDiagnostic?.({
        kind: 'token-undecryptable',
        message: messageOf(error),
      })
      return undefined
    }
  }

  async save(request: CompanionConfigSave): Promise<CompanionConfigSaveOutcome> {
    const { push, outcome } = this.nextPush(request.push)
    this.state = {
      enabled: request.enabled,
      port: request.port,
      ...(this.state.credential === undefined
        ? {}
        : { credential: this.state.credential }),
      ...(push === undefined ? {} : { push }),
    }
    await this.persist()
    return outcome
  }

  async setCredential(credential: CompanionCredentialRecord): Promise<void> {
    this.state = { ...this.state, credential }
    await this.persist()
  }

  async clearCredential(): Promise<void> {
    const { credential: _cleared, ...rest } = this.state
    this.state = rest
    await this.persist()
  }

  flush(): Promise<void> {
    return this.pendingWrite
  }

  private nextPush(request: CompanionConfigSave['push']): {
    readonly push: CompanionStoredPush | undefined
    readonly outcome: CompanionConfigSaveOutcome
  } {
    const saved: CompanionConfigSaveOutcome = { outcome: 'saved' }
    if (request === undefined) return { push: undefined, outcome: saved }
    const kept = this.state.push?.tokenCiphertext
    if (request.token === undefined) {
      return { push: withCiphertext(request.url, kept), outcome: saved }
    }
    if (request.token === '') return { push: { url: request.url }, outcome: saved }
    if (!this.options.secrets.isEncryptionAvailable()) {
      return {
        push: withCiphertext(request.url, kept),
        outcome: { outcome: 'token-rejected', reason: 'encryption-unavailable' },
      }
    }
    const ciphertext = this.options.secrets
      .encryptString(request.token)
      .toString('base64')
    return { push: { url: request.url, tokenCiphertext: ciphertext }, outcome: saved }
  }

  private persist(): Promise<void> {
    const snapshot = { version: FILE_VERSION, ...this.state }
    const write = this.pendingWrite
      .catch(() => undefined)
      .then(() => this.host.writeFile(this.file, JSON.stringify(snapshot, null, 2)))
    this.pendingWrite = write
    return write
  }
}

function withCiphertext(
  url: string,
  tokenCiphertext: string | undefined,
): CompanionStoredPush {
  return tokenCiphertext === undefined ? { url } : { url, tokenCiphertext }
}

function parseStored(value: Record<string, unknown>): CompanionStoredConfig {
  const credential = value['credential']
  const push = value['push']
  return {
    enabled: value['enabled'] === true,
    port: isCompanionPort(value['port']) ? value['port'] : COMPANION_DEFAULT_PORT,
    ...(isCredential(credential) ? { credential } : {}),
    ...(isStoredPush(push) ? { push } : {}),
  }
}

function isCredential(value: unknown): value is CompanionCredentialRecord {
  return (
    isRecord(value) &&
    typeof value['hash'] === 'string' &&
    typeof value['issuedAt'] === 'number' &&
    Number.isFinite(value['issuedAt'])
  )
}

function isStoredPush(value: unknown): value is CompanionStoredPush {
  return (
    isRecord(value) &&
    isCompanionPushUrl(value['url']) &&
    (value['tokenCiphertext'] === undefined ||
      typeof value['tokenCiphertext'] === 'string')
  )
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

function unreadable(error: unknown): CompanionConfigDiagnostic {
  return { kind: 'unreadable', message: messageOf(error) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
