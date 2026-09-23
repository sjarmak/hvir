import { createHash } from 'node:crypto'
import type { HostPath } from '../../shared'
import { ARCHITECTURE_SCOPE } from '../../shared/architecture-review'
import type { GitCommandContext } from '../git/git-command-context'

/** Git's length-delimited batch protocol avoids one process per captured source. */
export async function readArchitectureBlobs(
  context: GitCommandContext,
  root: HostPath,
  objects: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(objects)]
  if (ids.length === 0) return new Map()
  if (ids.some((id) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)))
    throw new Error('Invalid architecture source object')
  const result = await context.readOnly(root, ['cat-file', '--batch'], {
    input: `${ids.join('\n')}\n`,
    maxBuffer: ARCHITECTURE_SCOPE.maxTotalBytes + ids.length * 100,
  })
  if (result.code !== 0)
    throw new Error(`Architecture source read failed: ${result.stderr}`)
  const bytes = Buffer.from(result.stdout, 'utf8')
  const contents = new Map<string, string>()
  let offset = 0
  for (const id of ids) {
    const end = bytes.indexOf(10, offset)
    const header = bytes.subarray(offset, end).toString('ascii')
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header)
    if (end < offset || !match || match[1] !== id)
      throw new Error('Malformed architecture source batch')
    const size = Number(match[2])
    if (!Number.isSafeInteger(size) || size > ARCHITECTURE_SCOPE.maxFileBytes)
      throw new Error('Unsupported large architecture source')
    const content = bytes.subarray(end + 1, end + 1 + size)
    const hash = createHash(id.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${size}\0`)
      .update(content)
      .digest('hex')
    // Buffered ProjectHost output is UTF-8 text. Re-hashing proves decoding did
    // not replace invalid bytes and that the exact pinned object was returned.
    if (content.length !== size || bytes[end + 1 + size] !== 10 || hash !== id)
      throw new Error('Unsupported invalid UTF-8 or changed architecture source object')
    contents.set(id, content.toString('utf8'))
    offset = end + size + 2
  }
  if (offset !== bytes.length)
    throw new Error('Unexpected architecture source batch data')
  return contents
}
