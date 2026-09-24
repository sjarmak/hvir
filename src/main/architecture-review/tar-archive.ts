/**
 * A reader for the tar stream the live-tree read produces (ADR-063: one batched host command
 * per scan). It accepts what GNU tar, bsdtar and busybox tar emit for regular files, links and
 * long names, and refuses anything it cannot frame exactly rather than guessing.
 */

const BLOCK = 512

export type TarEntryType = 'file' | 'symlink' | 'other'

export interface TarEntry {
  readonly name: string
  readonly type: TarEntryType
  /** The file's bytes; empty for anything that is not a regular file. */
  readonly content: Buffer
}

/** The stream stopped framing: `complete` entries were read whole before it broke. */
export class TarFramingError extends Error {
  constructor(
    readonly complete: number,
    detail: string,
  ) {
    super(`Malformed architecture live-read archive after ${complete} entries: ${detail}`)
  }
}

interface Pending {
  readonly name?: string
  readonly linkName?: string
  readonly size?: number
}

export function readTarEntries(archive: Buffer): readonly TarEntry[] {
  const entries: TarEntry[] = []
  const byName = new Map<string, TarEntry>()
  let pending: Pending = {}
  let offset = 0
  const fail = (detail: string): never => {
    throw new TarFramingError(entries.length, detail)
  }
  while (offset < archive.length) {
    if (offset + BLOCK > archive.length) fail('truncated header')
    const header = archive.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (header.every((byte) => byte === 0)) continue
    if (!checksumMatches(header)) fail('header checksum mismatch')
    const size = pending.size ?? octal(header, 124, 12, fail)
    const end = offset + size
    if (end > archive.length) fail('truncated content')
    const content = archive.subarray(offset, end)
    offset += Math.ceil(size / BLOCK) * BLOCK
    const flag = String.fromCharCode(header[156]!)
    if (flag === 'L') pending = { ...pending, name: cString(content) }
    else if (flag === 'K') pending = { ...pending, linkName: cString(content) }
    else if (flag === 'x') pending = { ...pending, ...paxFields(content, fail) }
    else if (flag !== 'g') {
      const entry = member(header, flag, content, pending, byName, fail)
      entries.push(entry)
      byName.set(entry.name, entry)
      pending = {}
    }
  }
  return entries
}

function member(
  header: Buffer,
  flag: string,
  content: Buffer,
  pending: Pending,
  byName: ReadonlyMap<string, TarEntry>,
  fail: (detail: string) => never,
): TarEntry {
  const name = pending.name ?? headerName(header)
  if (flag === '0' || flag === '\0' || flag === '7')
    return { name, type: 'file', content }
  if (flag === '2') return { name, type: 'symlink', content: Buffer.alloc(0) }
  if (flag === '1') {
    const target = byName.get(pending.linkName ?? field(header, 157, 100))
    if (target?.type !== 'file') return fail(`hard link ${name} has no earlier file`)
    return { name, type: 'file', content: target.content }
  }
  return { name, type: 'other', content: Buffer.alloc(0) }
}

function headerName(header: Buffer): string {
  const name = field(header, 0, 100)
  const ustar = header.subarray(257, 263).toString('latin1') === 'ustar\0'
  const prefix = ustar ? field(header, 345, 155) : ''
  return prefix ? `${prefix}/${name}` : name
}

function checksumMatches(header: Buffer): boolean {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1)
    sum += index >= 148 && index < 156 ? 32 : header[index]!
  const recorded = field(header, 148, 8).trim()
  return /^[0-7]+$/.test(recorded) && Number.parseInt(recorded, 8) === sum
}

function octal(
  header: Buffer,
  start: number,
  length: number,
  fail: (detail: string) => never,
): number {
  const text = field(header, start, length).trim()
  if (!/^[0-7]+$/.test(text)) return fail('unsupported numeric field')
  return Number.parseInt(text, 8)
}

function field(header: Buffer, start: number, length: number): string {
  return cString(header.subarray(start, start + length))
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0)
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8')
}

/** POSIX extended header records: "<length> <key>=<value>\n". */
function paxFields(content: Buffer, fail: (detail: string) => never): Pending {
  let fields: Pending = {}
  let offset = 0
  while (offset < content.length) {
    const space = content.indexOf(32, offset)
    const length = Number(content.subarray(offset, space).toString('latin1'))
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0)
      return fail('malformed extended header')
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    const key = record.slice(0, equals)
    const value = record.slice(equals + 1)
    if (key === 'path') fields = { ...fields, name: value }
    else if (key === 'linkpath') fields = { ...fields, linkName: value }
    else if (key === 'size') {
      const size = Number(value)
      if (!Number.isSafeInteger(size) || size < 0) return fail('malformed extended size')
      fields = { ...fields, size }
    }
    offset += length
  }
  return fields
}
