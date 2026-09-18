import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { CompanionPairingCode } from '../../shared'
import type { CompanionAuthPort } from './companion-auth'
import type { CompanionCredentialRecord } from './companion-config-store'

export type { CompanionCredentialRecord } from './companion-config-store'

export const PAIRING_CODE_TTL_MS = 10 * 60_000
const CODE_GROUPS = 6
const GROUP_LENGTH = 4
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOKEN_BYTES = 32

/** Where the credential hash lives between runs; the pairing never keeps a token. */
export interface CompanionCredentialPort {
  current(): CompanionCredentialRecord | undefined
  store(record: CompanionCredentialRecord): void
  clear(): void
}

export type CompanionPairingEvent = 'issued' | 'paired' | 'revoked'

export interface CompanionPairingOptions {
  readonly credential: CompanionCredentialPort
  readonly now?: () => number
  /** Closes what the credential was keeping open (ADR-049: revoke ends every Companion page). */
  readonly onRevoked?: () => void
  readonly onChange?: (event: CompanionPairingEvent) => void
}

/**
 * The one-time pairing and the long-lived credential it mints (ADR-049).
 *
 * A code is exchanged exactly once for a token the phone keeps; hvir keeps
 * only the token's hash. Issuing again replaces the outstanding code, and a
 * code past its ten minutes is refused as if it had never been issued.
 */
export class CompanionPairing implements CompanionAuthPort {
  private outstanding: CompanionPairingCode | undefined
  private readonly now: () => number

  constructor(private readonly options: CompanionPairingOptions) {
    this.now = options.now ?? Date.now
  }

  issue(): CompanionPairingCode {
    const issued = { code: newPairingCode(), expiresAt: this.now() + PAIRING_CODE_TTL_MS }
    this.outstanding = issued
    this.options.onChange?.('issued')
    return issued
  }

  /** The code a phone may still exchange, or undefined once used or expired. */
  outstandingCode(): CompanionPairingCode | undefined {
    if (this.outstanding !== undefined && this.outstanding.expiresAt < this.now()) {
      this.outstanding = undefined
    }
    return this.outstanding
  }

  paired(): boolean {
    return this.options.credential.current() !== undefined
  }

  exchange(code: string): string | undefined {
    const outstanding = this.outstandingCode()
    if (outstanding === undefined || !sameSecret(normalizeCode(code), outstanding.code)) {
      return undefined
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    this.outstanding = undefined
    this.options.credential.store({
      hash: hashCompanionToken(token),
      issuedAt: this.now(),
    })
    this.options.onChange?.('paired')
    return token
  }

  verify(token: string): boolean {
    const record = this.options.credential.current()
    return record !== undefined && sameSecret(hashCompanionToken(token), record.hash)
  }

  revoke(): void {
    this.outstanding = undefined
    this.options.credential.clear()
    this.options.onRevoked?.()
    this.options.onChange?.('revoked')
  }
}

export function hashCompanionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newPairingCode(): string {
  const bytes = randomBytes(CODE_GROUPS * GROUP_LENGTH)
  const groups: string[] = []
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let text = ''
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      // 256 is a multiple of 32, so the low five bits are unbiased.
      text += BASE32[bytes[group * GROUP_LENGTH + index]! & 31]
    }
    groups.push(text)
  }
  return groups.join('-')
}

/** The code as a person types it: case and separators carry no information. */
function normalizeCode(typed: string): string {
  const letters = typed.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const groups: string[] = []
  for (let offset = 0; offset < letters.length; offset += GROUP_LENGTH) {
    groups.push(letters.slice(offset, offset + GROUP_LENGTH))
  }
  return groups.join('-')
}

function sameSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}
