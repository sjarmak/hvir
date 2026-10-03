import { posix } from 'node:path'

import { hostPath, measureTextWorkload, type HostPath } from '../../shared'
import type {
  ReviewCheckpointChange,
  ReviewCheckpointDiff,
  ReviewCheckpointHostRequest,
  ReviewCheckpointHostResult,
  ReviewCheckpointInspection,
  ReviewCheckpointObject,
  ReviewCheckpointStatus,
} from '../../shared/review-checkpoint'
import {
  assertCheckpointRelativePath,
  compareCheckpointEntries,
  isCheckpointObjectId,
  parseCheckpointTree,
  type CheckpointEntry,
  type CheckpointTreeEntry,
} from './review-checkpoint-model'

export interface ReviewCheckpointCapabilityPort {
  call(request: ReviewCheckpointHostRequest): Promise<ReviewCheckpointHostResult>
}

export class ReviewCheckpointCapability {
  constructor(
    private readonly port: ReviewCheckpointCapabilityPort,
    private readonly root: HostPath,
  ) {}

  private call(
    request: ReviewCheckpointHostRequest,
  ): Promise<ReviewCheckpointHostResult> {
    return this.port.call(request)
  }

  async status(): Promise<ReviewCheckpointStatus> {
    const inspection = await this.inspect()
    if (!inspection.oid) return { root: inspection.root, oid: null, changes: [] }
    const baseline = parseCheckpointTree(
      expectString(await this.call({ action: 'tree', oid: inspection.oid })),
    )
    const live = await this.collectLive(false)
    if ((await this.inspect()).oid !== inspection.oid)
      throw new Error('Checkpoint baseline changed; refresh changes since review')
    return {
      root: inspection.root,
      oid: inspection.oid,
      changes: changesFor(inspection.root, baseline, live),
    }
  }

  async capture(): Promise<ReviewCheckpointStatus> {
    const initial = await this.inspect()
    const live = await this.collectLive(true)
    const tree = await this.writeRootTree(live)
    const verified = await this.collectLive(false)
    assertSameLive(live, verified)
    const finalInspection = await this.inspect()
    if (finalInspection.oid !== initial.oid)
      throw new Error('Checkpoint baseline changed during capture')
    await this.call({ action: 'update-ref', oid: tree, previous: initial.oid })
    return {
      root: finalInspection.root,
      oid: tree,
      changes: [],
    }
  }

  async clear(): Promise<void> {
    const inspection = await this.inspect()
    if (inspection.oid) await this.call({ action: 'clear-ref', previous: inspection.oid })
  }

  async diff(
    checkpoint: string,
    change: ReviewCheckpointChange,
  ): Promise<ReviewCheckpointDiff> {
    if (!isCheckpointObjectId(checkpoint))
      throw new Error('Invalid checkpoint object identity')
    const inspection = await this.inspect()
    if (inspection.oid !== checkpoint) throw new Error('Checkpoint baseline changed')
    const baseline = parseCheckpointTree(
      expectString(await this.call({ action: 'tree', oid: checkpoint })),
    )
    const relativePath = relativePathFor(this.root, change.path)
    const saved = baseline.find((entry) => entry.relativePath === relativePath)
    if (!sameObject(saved, change.before)) throw new Error('Checkpoint change is stale')
    validateObject(change.after)
    const current = await this.call({
      action: 'read-live',
      relativePath,
      expected: change.after,
    })
    const checkpointText = saved
      ? await this.call({ action: 'blob', oid: saved.oid })
      : measureTextWorkload('')
    if ((await this.inspect()).oid !== checkpoint)
      throw new Error('Checkpoint baseline changed; refresh changes since review')
    return {
      path: change.path,
      checkpoint,
      baseInput: expectTextWorkload(checkpointText),
      currentInput: expectTextWorkload(current),
    }
  }

  private async inspect(): Promise<ReviewCheckpointInspection> {
    return expectInspection(await this.call({ action: 'inspect' }))
  }

  private async collectLive(write: boolean): Promise<readonly CheckpointEntry[]> {
    const files = parseFileList(await this.call({ action: 'files' }))
    parseTracked(await this.call({ action: 'tracked' }))
    const entries: CheckpointEntry[] = []
    for (const relativePath of files) {
      const result = expectObject(
        await this.call({ action: 'hash', relativePath, write }),
      )
      if (result) entries.push({ relativePath, ...result })
    }
    return entries.sort((a, b) => comparePath(a.relativePath, b.relativePath))
  }

  private async writeRootTree(entries: readonly CheckpointEntry[]): Promise<string> {
    const root = makeTree(entries)
    return this.writeTree(root)
  }

  private async writeTree(node: TreeNode): Promise<string> {
    const children: CheckpointTreeEntry[] = []
    for (const entry of node.files.values())
      children.push({ name: entry.name, mode: entry.mode, oid: entry.oid })
    for (const [name, child] of node.directories) {
      children.push({ name, mode: '040000', oid: await this.writeTree(child) })
    }
    return expectString(await this.call({ action: 'write-tree', entries: children }))
  }
}

interface TreeNode {
  readonly files: Map<string, CheckpointTreeEntry>
  readonly directories: Map<string, TreeNode>
}

function makeTree(entries: readonly CheckpointEntry[]): TreeNode {
  const root: TreeNode = { files: new Map(), directories: new Map() }
  for (const entry of entries) {
    const parts = entry.relativePath.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let child = node.directories.get(part)
      if (!child) {
        child = { files: new Map(), directories: new Map() }
        node.directories.set(part, child)
      }
      node = child
    }
    const name = parts.at(-1)!
    if (node.directories.has(name) || node.files.has(name))
      throw new Error('Conflicting checkpoint tree path')
    node.files.set(name, { name, mode: entry.mode, oid: entry.oid })
  }
  return root
}

function parseFileList(result: ReviewCheckpointHostResult): readonly string[] {
  const output = expectString(result)
  if (!output) return []
  if (!output.endsWith('\0')) throw new Error('Truncated checkpoint file list')
  const paths = output.slice(0, -1).split('\0')
  for (const path of paths) assertCheckpointRelativePath(path)
  if (new Set(paths).size !== paths.length)
    throw new Error('Duplicate checkpoint file path')
  return [...new Set(paths)].sort(comparePath)
}

function parseTracked(result: ReviewCheckpointHostResult): readonly string[] {
  const output = expectString(result)
  if (!output) return []
  if (!output.endsWith('\0')) throw new Error('Truncated tracked file list')
  const paths: string[] = []
  for (const record of output.slice(0, -1).split('\0')) {
    const match = /^([A-Za-z]) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) (\d+)\t/.exec(record)
    if (!match) throw new Error('Malformed tracked file list')
    const [, marker, mode, , stage] = match
    if (marker === 'S' || marker === 's' || stage !== '0' || mode === '160000')
      throw new Error('Unsupported tracked file entry')
    const path = record.slice(match[0].length)
    assertCheckpointRelativePath(path)
    if (paths.includes(path)) throw new Error('Duplicate tracked file path')
    paths.push(path)
  }
  return paths.sort(comparePath)
}

function changesFor(
  root: HostPath,
  baseline: readonly CheckpointEntry[],
  live: readonly CheckpointEntry[],
): readonly ReviewCheckpointChange[] {
  return compareCheckpointEntries(baseline, live).map((change) => ({
    path: hostPath(root.hostId, posix.join(root.path, change.relativePath)),
    before: change.before ? { mode: change.before.mode, oid: change.before.oid } : null,
    after: change.after ? { mode: change.after.mode, oid: change.after.oid } : null,
  }))
}

function assertSameLive(
  before: readonly CheckpointEntry[],
  after: readonly CheckpointEntry[],
): void {
  if (compareCheckpointEntries(before, after).length)
    throw new Error('Workspace changed during capture')
}

function relativePathFor(root: HostPath, path: HostPath): string {
  if (path.hostId !== root.hostId)
    throw new Error('Checkpoint change belongs to another host')
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`
  if (!path.path.startsWith(prefix)) throw new Error('Checkpoint change leaves its root')
  const relativePath = path.path.slice(prefix.length)
  assertCheckpointRelativePath(relativePath)
  return relativePath
}

function sameObject(
  entry: CheckpointEntry | undefined,
  object: ReviewCheckpointObject | null,
): boolean {
  return entry ? object?.mode === entry.mode && object.oid === entry.oid : object === null
}

function validateObject(object: ReviewCheckpointObject | null): void {
  if (
    object &&
    (!isCheckpointObjectId(object.oid) ||
      !['100644', '100755', '120000'].includes(object.mode))
  )
    throw new Error('Invalid checkpoint object')
}

function expectInspection(
  result: ReviewCheckpointHostResult,
): ReviewCheckpointInspection {
  if (!result || typeof result !== 'object' || !('root' in result) || !('oid' in result))
    throw new Error('Invalid checkpoint inspection')
  return result
}

function expectObject(result: ReviewCheckpointHostResult): ReviewCheckpointObject | null {
  if (result === null) return null
  if (typeof result !== 'object' || !('oid' in result) || !('mode' in result))
    throw new Error('Invalid checkpoint object')
  return result
}

function expectString(result: ReviewCheckpointHostResult): string {
  if (typeof result !== 'string') throw new Error('Invalid checkpoint text result')
  return result
}

function expectTextWorkload(
  result: ReviewCheckpointHostResult,
): ReviewCheckpointDiff['baseInput'] {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !('complete' in result)
  )
    throw new Error('Invalid checkpoint text workload')
  return result
}

function comparePath(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right))
}
