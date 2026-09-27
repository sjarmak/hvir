import type { HostPath } from '../../shared'
import { ARCHITECTURE_SCOPE } from '../../shared/architecture-review'
import type { GitCommandContext } from '../git/git-command-context'
import { gitBlobId, objectFormat } from './blob-id'
import type { ArchitectureBlobCache } from './scan-caches'

export interface ArchitectureBlobRead {
  readonly contents: ReadonlyMap<string, string>
  readonly fetchedBytes: number
}

interface FetchedBlob {
  readonly id: string
  readonly content: string
  readonly bytes: number
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

/** Git's length-delimited batch protocol avoids one process per captured source. */
export async function readArchitectureBlobs(
  context: GitCommandContext,
  root: HostPath,
  objects: readonly string[],
  cache?: ArchitectureBlobCache,
): Promise<ArchitectureBlobRead> {
  const ids = [...new Set(objects)]
  if (ids.some((id) => !OBJECT_ID.test(id)))
    throw new Error('Invalid architecture source object')
  const contents = new Map<string, string>()
  const missing: string[] = []
  for (const id of ids) {
    const cached = cache?.lookup(id)
    if (cached === undefined) missing.push(id)
    else contents.set(id, cached)
  }
  if (missing.length === 0) return { contents, fetchedBytes: 0 }
  const result = await context.readOnly(root, ['cat-file', '--batch'], {
    input: `${missing.join('\n')}\n`,
    maxBuffer: ARCHITECTURE_SCOPE.maxTotalBytes + missing.length * 100,
  })
  if (result.code !== 0)
    throw new Error(`Architecture source read failed: ${result.stderr}`)
  let fetchedBytes = 0
  for (const blob of parseBlobBatch(Buffer.from(result.stdout, 'utf8'), missing)) {
    contents.set(blob.id, blob.content)
    cache?.store(blob.id, blob.content, blob.bytes)
    fetchedBytes += blob.bytes
  }
  return { contents, fetchedBytes }
}

function parseBlobBatch(bytes: Buffer, ids: readonly string[]): readonly FetchedBlob[] {
  const blobs: FetchedBlob[] = []
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
    const hash = gitBlobId(content, objectFormat(id))
    if (content.length !== size || bytes[end + 1 + size] !== 10 || hash !== id)
      throw new Error('Unsupported invalid UTF-8 or changed architecture source object')
    blobs.push({ id, content: content.toString('utf8'), bytes: size })
    offset = end + size + 2
  }
  if (offset !== bytes.length)
    throw new Error('Unexpected architecture source batch data')
  return blobs
}

export async function readArchitectureBlobSizes(
  context: GitCommandContext,
  root: HostPath,
  objects: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const ids = [...new Set(objects)]
  if (ids.length === 0) return new Map()
  if (ids.some((id) => !OBJECT_ID.test(id)))
    throw new Error('Invalid architecture source object')
  const result = await context.readOnly(root, ['cat-file', '--batch-check'], {
    input: `${ids.join('\n')}\n`,
    maxBuffer: ids.length * 128 + 1024,
  })
  if (result.code !== 0)
    throw new Error(`Architecture source size read failed: ${result.stderr}`)
  const sizes = new Map<string, number>()
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(line)
    if (!match) continue
    const size = Number(match[2])
    if (Number.isSafeInteger(size)) sizes.set(match[1]!, size)
  }
  return sizes
}
