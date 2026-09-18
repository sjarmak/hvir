/**
 * The ports the Companion server consumes and the pairing admission policy
 * it applies before touching them (ADR-049). Credentials live behind
 * CompanionAuthPort; the server never sees a hash or a stored code.
 */

/** The page the reader serves for GET /; the remaining entries are assets/*. */
export const COMPANION_INDEX_PATH = 'companion/index.html'

export const PAIRING_FAILURE_LIMIT = 5
export const PAIRING_FAILURE_WINDOW_MS = 60_000

export interface CompanionAuthPort {
  /** Trades the outstanding one-time pairing code for a bearer token, once. */
  exchange(code: string): string | undefined
  /** Constant-time comparison against the paired credential, owned by the port. */
  verify(token: string): boolean
}

export interface CompanionAsset {
  readonly body: Uint8Array
  readonly contentType: string
}

export interface CompanionAssetReader {
  /** Resolves a normalized relative path inside the allowlisted bundle, or nothing. */
  read(relativePath: string): Promise<CompanionAsset | undefined>
}

/**
 * Admits at most PAIRING_FAILURE_LIMIT failed exchanges per sliding window.
 * The listener is loopback-only, so the limiter is per server, not per peer.
 */
export class PairingRateLimiter {
  private failures: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  blocked(): boolean {
    const cutoff = this.now() - PAIRING_FAILURE_WINDOW_MS
    this.failures = this.failures.filter((at) => at > cutoff)
    return this.failures.length >= PAIRING_FAILURE_LIMIT
  }

  fail(): void {
    this.failures = [...this.failures, this.now()]
  }
}
