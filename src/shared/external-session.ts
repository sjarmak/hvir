import type { SessionsExternalSourceId } from './sessions-projection'

/**
 * The link between a terminal hvir launched and the foreign session it attached
 * to.
 *
 * hvir only ever claims this link for an attach it performed itself: the
 * surface that runs the attach command knows exactly which session it named, so
 * the target travels with the launch instead of being guessed afterwards from a
 * title, a path, or what happened to start at the same moment (ADR-046).
 */

/** What an attach names: a session in the foreign source's own namespace. */
export interface ExternalSessionAttachTarget {
  readonly sourceId: SessionsExternalSourceId
  /**
   * The foreign identifier. It crosses terminal IPC as the argument of the
   * attach hvir is about to run, and is hashed before anything persists it.
   */
  readonly key: string
}

/**
 * The attach, as hvir records it: the source, plus a digest of the identifier.
 *
 * Equality over the digest joins the terminal to its session exactly, which is
 * all the join needs, and it keeps the other system's identifiers out of hvir's
 * own files — the same reason a harness artifact is stored as a digest.
 */
export interface ExternalSessionAttachment {
  readonly sourceId: SessionsExternalSourceId
  readonly sessionDigest: string
}

/** Every source that can be attached to; the validator's allowed set. */
export const EXTERNAL_SESSION_SOURCE_IDS = [
  'gas-city',
] as const satisfies readonly SessionsExternalSourceId[]

/**
 * gc session names, aliases and ids are short identifiers. The bound is
 * generous enough for a rig-qualified path and small enough that a hostile
 * renderer cannot hand main an unbounded string to hash.
 */
export const MAX_EXTERNAL_SESSION_KEY_LENGTH = 240

export function isExternalSessionAttachTarget(
  value: unknown,
): value is ExternalSessionAttachTarget {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ExternalSessionAttachTarget>
  return (
    typeof candidate.sourceId === 'string' &&
    (EXTERNAL_SESSION_SOURCE_IDS as readonly string[]).includes(candidate.sourceId) &&
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    candidate.key.length <= MAX_EXTERNAL_SESSION_KEY_LENGTH &&
    ![...candidate.key].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
}

/** The stored digest shape, matching the hash width persistence validates. */
export function isExternalSessionDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
}

/** The stored attachment shape, for records read back off disk. */
export function isExternalSessionAttachment(
  value: unknown,
): value is ExternalSessionAttachment {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ExternalSessionAttachment>
  return (
    typeof candidate.sourceId === 'string' &&
    (EXTERNAL_SESSION_SOURCE_IDS as readonly string[]).includes(candidate.sourceId) &&
    isExternalSessionDigest(candidate.sessionDigest)
  )
}

export function sameExternalSessionAttachment(
  left: ExternalSessionAttachment | undefined,
  right: ExternalSessionAttachment | undefined,
): boolean {
  if (!left || !right) return left === right
  return left.sourceId === right.sourceId && left.sessionDigest === right.sessionDigest
}
