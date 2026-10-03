import { posix } from 'node:path'

import { hostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host/project-host'
import {
  assertCheckpointRelativePath,
  type CheckpointMode,
} from './review-checkpoint-model'

export const CHECKPOINT_MAX_FILE_BYTES = 8 * 1024 * 1024

export interface CheckpointFile {
  readonly mode: CheckpointMode
  readonly bytes: Buffer
}

export async function readCheckpointFile(
  host: ProjectHost,
  root: HostPath,
  relativePath: string,
  signal: AbortSignal,
): Promise<CheckpointFile | null> {
  if (root.hostId !== host.hostId)
    throw new Error('Checkpoint root belongs to another host')
  assertCheckpointRelativePath(relativePath)
  signal.throwIfAborted()

  const rootStat = await host.stat(root)
  signal.throwIfAborted()
  if (rootStat.type !== 'dir') throw new Error('Checkpoint root is not a directory')
  const canonicalRoot = await host.realpath(root)
  signal.throwIfAborted()
  if (canonicalRoot.hostId !== host.hostId)
    throw new Error('Checkpoint root belongs to another host')

  const candidate = hostPath(host.hostId, posix.join(root.path, relativePath))
  let before
  try {
    before = await host.stat(candidate)
    signal.throwIfAborted()
  } catch (reason) {
    if (isMissing(reason)) return null
    throw reason
  }

  const parent = posix.dirname(candidate.path)
  const canonicalParent = posix.join(canonicalRoot.path, posix.dirname(relativePath))
  const parentPath = hostPath(host.hostId, parent)
  const resolvedParent = await host.realpath(parentPath)
  signal.throwIfAborted()
  if (resolvedParent.hostId !== root.hostId || resolvedParent.path !== canonicalParent)
    throw new Error('Checkpoint path leaves its canonical root')

  if (before.type !== 'file' && before.type !== 'symlink')
    throw new Error('Unsupported checkpoint entry type')
  if (
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    before.size > CHECKPOINT_MAX_FILE_BYTES
  )
    throw new Error('Checkpoint file size limit exceeded')

  const mode = checkpointMode(before.type, before.mode)
  let bytes: Buffer
  if (before.type === 'symlink') {
    bytes = await host.readlink(candidate)
    signal.throwIfAborted()
    if (bytes.byteLength > CHECKPOINT_MAX_FILE_BYTES)
      throw new Error('Checkpoint file size limit exceeded')
  } else {
    const transfer = host.fileTransfer
    if (!transfer) throw new Error('Host does not support bounded file reads')
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of transfer.readFileChunks(candidate, { signal })) {
      signal.throwIfAborted()
      total += chunk.byteLength
      if (total > CHECKPOINT_MAX_FILE_BYTES || total > before.size)
        throw new Error('Checkpoint file grew beyond its bounded snapshot')
      chunks.push(Buffer.from(chunk))
    }
    signal.throwIfAborted()
    if (total !== before.size) throw new Error('Checkpoint file changed while reading')
    bytes = Buffer.concat(chunks, total)
  }

  const resolved = before.type === 'file' ? await host.realpath(candidate) : undefined
  signal.throwIfAborted()
  if (
    resolved &&
    (resolved.hostId !== root.hostId ||
      resolved.path !== posix.join(canonicalRoot.path, relativePath))
  )
    throw new Error('Checkpoint path resolves outside its canonical root')
  const after = await host.stat(candidate)
  signal.throwIfAborted()
  if (!sameStat(before, after)) throw new Error('Checkpoint file changed while reading')
  if (before.type === 'symlink' && bytes.byteLength !== before.size)
    throw new Error('Checkpoint symlink changed while reading')
  return { mode, bytes }
}

function checkpointMode(type: 'file' | 'symlink', mode: number): CheckpointMode {
  if (type === 'symlink') return '120000'
  return (mode & 0o111) === 0 ? '100644' : '100755'
}

function sameStat(
  before: {
    readonly type: string
    readonly size: number
    readonly mtimeMs: number
    readonly mode: number
  },
  after: {
    readonly type: string
    readonly size: number
    readonly mtimeMs: number
    readonly mode: number
  },
): boolean {
  return (
    before.type === after.type &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.mode === after.mode
  )
}

function isMissing(reason: unknown): boolean {
  const code = (reason as { readonly code?: unknown } | undefined)?.code
  return code === 'ENOENT' || code === 2
}
