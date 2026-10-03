export const CHECKPOINT_MAX_ENTRIES = 10_000
export const CHECKPOINT_MAX_TREE_BYTES = 4 * 1024 * 1024
export const CHECKPOINT_MAX_PATH_BYTES = 16 * 1024

export type CheckpointMode = '100644' | '100755' | '120000'
export type CheckpointTreeMode = CheckpointMode | '040000'

export interface CheckpointEntry {
  readonly relativePath: string
  readonly mode: CheckpointMode
  readonly oid: string
}

export interface CheckpointChange {
  readonly relativePath: string
  readonly before?: CheckpointEntry
  readonly after?: CheckpointEntry
}

export interface CheckpointTreeEntry {
  readonly name: string
  readonly mode: CheckpointTreeMode
  readonly oid: string
}

export function parseCheckpointTree(output: string): readonly CheckpointEntry[] {
  assertTreeSize(output)
  if (output.length === 0) return []
  if (!output.endsWith('\0')) throw new Error('Truncated checkpoint tree output')
  const entries: CheckpointEntry[] = []
  const paths = new Set<string>()
  let oidLength: number | undefined
  for (const record of output.slice(0, -1).split('\0')) {
    if (!record) throw new Error('Invalid checkpoint tree record')
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(
      record,
    )
    if (!match) throw new Error('Invalid checkpoint tree record')
    const mode = match[1]
    const oid = match[2]
    if (!mode || !oid) throw new Error('Invalid checkpoint tree record')
    if (oidLength !== undefined && oid.length !== oidLength)
      throw new Error('Mixed checkpoint object-id lengths')
    oidLength = oid.length
    const relativePath = record.slice(match[0].length)
    assertCheckpointRelativePath(relativePath)
    if (paths.has(relativePath)) throw new Error('Duplicate checkpoint path')
    paths.add(relativePath)
    if (paths.size > CHECKPOINT_MAX_ENTRIES)
      throw new Error('Checkpoint tree entry limit exceeded')
    entries.push({ relativePath, mode: mode as CheckpointMode, oid })
  }
  return entries.sort((a, b) => compareCheckpointText(a.relativePath, b.relativePath))
}

export function compareCheckpointEntries(
  before: readonly CheckpointEntry[],
  after: readonly CheckpointEntry[],
): readonly CheckpointChange[] {
  const beforeMap = checkpointEntryMap(before)
  const afterMap = checkpointEntryMap(after)
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(compareCheckpointText)
  return paths.flatMap((relativePath) => {
    const prior = beforeMap.get(relativePath)
    const current = afterMap.get(relativePath)
    if (prior && current && prior.mode === current.mode && prior.oid === current.oid)
      return []
    return [{ relativePath, ...(prior ? { before: prior } : {}), ...(current ? { after: current } : {}) }]
  })
}

export function encodeCheckpointTree(
  entries: readonly CheckpointTreeEntry[],
): string {
  if (entries.length > CHECKPOINT_MAX_ENTRIES) throw new Error('Checkpoint tree entry limit exceeded')
  const names = new Set<string>()
  let oidLength: number | undefined
  const encoded = entries.map(({ name, mode, oid }) => {
    assertCheckpointName(name)
    if (!isCheckpointTreeMode(mode)) throw new Error('Invalid checkpoint tree mode')
    if (names.has(name)) throw new Error('Duplicate checkpoint tree name')
    names.add(name)
    if (!isCheckpointObjectId(oid)) throw new Error('Invalid checkpoint object id')
    if (oidLength !== undefined && oid.length !== oidLength)
      throw new Error('Mixed checkpoint object-id lengths')
    oidLength = oid.length
    const type = mode === '040000' ? 'tree' : 'blob'
    return `${mode} ${type} ${oid}\t${name}\0`
  })
  const output = encoded.sort((a, b) => compareCheckpointText(a, b)).join('')
  assertTreeSize(output)
  return output
}

export function assertCheckpointRelativePath(path: string): void {
  assertPathText(path)
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  )
    throw new Error('Invalid checkpoint relative path')
}

export function isCheckpointObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)
}

function checkpointEntryMap(entries: readonly CheckpointEntry[]): Map<string, CheckpointEntry> {
  const result = new Map<string, CheckpointEntry>()
  let oidLength: number | undefined
  for (const entry of entries) {
    assertCheckpointRelativePath(entry.relativePath)
    if (!isCheckpointMode(entry.mode)) throw new Error('Invalid checkpoint mode')
    if (!isCheckpointObjectId(entry.oid)) throw new Error('Invalid checkpoint object id')
    if (oidLength !== undefined && entry.oid.length !== oidLength)
      throw new Error('Mixed checkpoint object-id lengths')
    oidLength = entry.oid.length
    if (result.has(entry.relativePath)) throw new Error('Duplicate checkpoint path')
    result.set(entry.relativePath, { ...entry })
  }
  if (result.size > CHECKPOINT_MAX_ENTRIES) throw new Error('Checkpoint tree entry limit exceeded')
  return result
}

function assertCheckpointName(name: string): void {
  assertPathText(name)
  if (!name || name.includes('/') || name === '.' || name === '..' || name === '.git')
    throw new Error('Invalid checkpoint tree name')
}

function isCheckpointMode(value: string): value is CheckpointMode {
  return value === '100644' || value === '100755' || value === '120000'
}

function isCheckpointTreeMode(value: string): value is CheckpointTreeMode {
  return value === '040000' || isCheckpointMode(value)
}

function assertPathText(path: string): void {
  if (path.includes('\0') || path.includes('\uFFFD')) throw new Error('Invalid checkpoint path text')
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = path.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        throw new Error('Invalid checkpoint path text')
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Invalid checkpoint path text')
    }
  }
  if (Buffer.byteLength(path, 'utf8') > CHECKPOINT_MAX_PATH_BYTES)
    throw new Error('Checkpoint path byte limit exceeded')
}

function assertTreeSize(output: string): void {
  if (Buffer.byteLength(output, 'utf8') > CHECKPOINT_MAX_TREE_BYTES)
    throw new Error('Checkpoint tree output limit exceeded')
}

function compareCheckpointText(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}
