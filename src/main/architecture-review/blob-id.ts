import { createHash } from 'node:crypto'

/**
 * Git's object id for a blob holding exactly these bytes. A 64-character id marks a SHA-256
 * repository; anything else is SHA-1, as Git's default object format is.
 */
export function gitBlobId(
  content: Uint8Array,
  format: 'sha1' | 'sha256' = 'sha1',
): string {
  return createHash(format)
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

export function objectFormat(id: string): 'sha1' | 'sha256' {
  return id.length === 64 ? 'sha256' : 'sha1'
}
