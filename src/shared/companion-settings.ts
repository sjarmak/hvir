/**
 * Companion settings as the Settings dialog sees and edits them (ADR-049).
 *
 * The stored credential and the push token never appear here. The view says
 * only whether each is configured, and a save carries the push token as a
 * write-only field the main process encrypts before it touches disk.
 */

export const COMPANION_DEFAULT_PORT = 47811
export const COMPANION_PORT_MIN = 1024
export const COMPANION_PORT_MAX = 65535
export const MAX_COMPANION_PUSH_TOKEN_LENGTH = 512
const MAX_COMPANION_PUSH_URL_LENGTH = 2048

/** A pairing code a phone may exchange once, until it expires. */
export interface CompanionPairingCode {
  readonly code: string
  readonly expiresAt: number
}

/** The declared push sink, with the token reduced to whether one is stored. */
export interface CompanionPushView {
  readonly url: string
  readonly tokenConfigured: boolean
}

/** What the loopback listener is doing right now. */
export interface CompanionListenerStatus {
  readonly listening: boolean
  readonly port?: number
  readonly error?: string
}

export interface CompanionConfigView {
  readonly enabled: boolean
  readonly port: number
  /** Whether an armed Companion page may type into a mirrored terminal (ADR-050). */
  readonly mirrorInputAllowed: boolean
  readonly paired: boolean
  /** Present only while a pairing code is outstanding. */
  readonly pairing?: CompanionPairingCode
  readonly push: CompanionPushView | undefined
  readonly status: CompanionListenerStatus
}

export interface CompanionPushSave {
  readonly url: string
  /** Write-only: omitted keeps the stored token, an empty string clears it. */
  readonly token?: string
}

export interface CompanionConfigSave {
  readonly enabled: boolean
  readonly port: number
  readonly mirrorInputAllowed: boolean
  /** Omitted removes the push sink altogether. */
  readonly push?: CompanionPushSave
}

const SAVE_KEYS: readonly string[] = ['enabled', 'port', 'mirrorInputAllowed', 'push']

export function isCompanionPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= COMPANION_PORT_MIN &&
    value <= COMPANION_PORT_MAX
  )
}

/**
 * A sink the token may be sent to: TLS anywhere, or plain HTTP only to this
 * machine's own loopback address, where the token never crosses a wire.
 */
export function isCompanionPushUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_COMPANION_PUSH_URL_LENGTH)
    return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
}

function isCompanionPushSave(value: unknown): value is CompanionPushSave {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => key === 'url' || key === 'token')) return false
  if (!isCompanionPushUrl(value['url'])) return false
  const token = value['token']
  return (
    token === undefined ||
    (typeof token === 'string' && token.length <= MAX_COMPANION_PUSH_TOKEN_LENGTH)
  )
}

export function isCompanionConfigSave(value: unknown): value is CompanionConfigSave {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => SAVE_KEYS.includes(key))) return false
  if (
    typeof value['enabled'] !== 'boolean' ||
    !isCompanionPort(value['port']) ||
    typeof value['mirrorInputAllowed'] !== 'boolean'
  ) {
    return false
  }
  return value['push'] === undefined || isCompanionPushSave(value['push'])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
