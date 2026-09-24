import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { localPath, type HostPath } from '../../shared/host-path'
import type { ProjectFileTransferPort, ProjectHost } from '../project-host/project-host'
import {
  ARCHITECTURE_SCANNER_VERSION,
  isModuleFacts,
  type ModuleFacts,
} from './module-facts'

/** Parsed module facts across every repository reviewed on this machine (ADR-063). */
export const ARCHITECTURE_PARSE_CACHE_BYTES = 256 * 1024 * 1024

/** What one cached parse is keyed by (ADR-063): where the blob lives, and which blob. */
export interface ModuleFactsKey {
  readonly hostId: string
  readonly repository: string
  /** Git's blob id for the module's exact bytes. */
  readonly blob: string
  /** From `parseKind`: the same bytes parse differently as `.ts` and `.tsx`. */
  readonly kind: string
}

/** The local files the cache keeps; LocalHost in the app, never a project's host. */
export type ModuleFactsCacheFiles = Pick<
  ProjectHost,
  | 'readFile'
  | 'writeFile'
  | 'removeFile'
  | 'readdir'
  | 'stat'
  | 'createDirectoryExclusive'
> & {
  readonly fileTransfer: Pick<ProjectFileTransferPort, 'setMetadata' | 'removeDirectory'>
}

export interface ModuleFactsCacheOptions {
  readonly files: ModuleFactsCacheFiles
  /** Absolute local directory owned by this cache; under Electron userData in the app. */
  readonly directory: string
  readonly maxBytes: number
  readonly scannerVersion?: string
  readonly now?: () => number
}

export interface ModuleFactsCacheStats {
  readonly hits: number
  readonly misses: number
  /** Entries that failed validation and were deleted so the module is parsed again. */
  readonly discarded: number
  readonly entries: number
  readonly bytes: number
}

interface IndexEntry {
  readonly bytes: number
  readonly used: number
  /** When `used` last reached the entry file's mtime. */
  readonly persisted: number
}
interface StoredEntry extends ModuleFactsKey {
  readonly version: string
  readonly digest: string
  readonly facts: ModuleFacts
}

const BLOB = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const KIND = /^(?:\.d)?\.[cm]?[jt]sx?$/
const ENTRY = /^[0-9a-f]{32}-[0-9a-f]+(?:\.d)?\.[cm]?[jt]sx?\.json$/
/** Recency is persisted at this granularity, so warm scans do not rewrite every entry. */
const RECENCY_GRANULARITY_MS = 60 * 60 * 1000
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const factsDigest = (facts: ModuleFacts): string => hash(JSON.stringify(facts))

/**
 * Parsed module facts on disk, one file per entry, bounded in bytes and evicted least
 * recently used. Recency is the entry file's mtime, so it survives a restart. One process
 * owns the directory at a time: the warm architecture worker in the app.
 */
export class ModuleFactsCache {
  private readonly version: string
  private readonly root: string
  private readonly now: () => number
  private opened: Promise<Map<string, IndexEntry>> | undefined
  private totalBytes = 0
  private counts = { hits: 0, misses: 0, discarded: 0 }
  private entries = 0

  constructor(private readonly options: ModuleFactsCacheOptions) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error('Architecture parse cache needs a positive byte budget')
    if (!posix.isAbsolute(options.directory))
      throw new Error('Architecture parse cache needs an absolute directory')
    this.version = options.scannerVersion ?? ARCHITECTURE_SCANNER_VERSION
    this.root = posix.join(
      options.directory,
      `scanner-${hash(this.version).slice(0, 16)}`,
    )
    this.now = options.now ?? Date.now
  }

  async lookup(key: ModuleFactsKey): Promise<ModuleFacts | undefined> {
    const name = this.entryName(key)
    const index = await this.open()
    const known = index.get(name)
    if (!known) return this.miss()
    const facts = await this.readEntry(name, key)
    if (!facts) return this.miss()
    const now = this.now()
    const persist = now - known.persisted >= RECENCY_GRANULARITY_MS
    index.set(name, { ...known, used: now, persisted: persist ? now : known.persisted })
    if (persist) await this.touch(name, now)
    this.counts = { ...this.counts, hits: this.counts.hits + 1 }
    return facts
  }

  async store(key: ModuleFactsKey, facts: ModuleFacts): Promise<void> {
    const name = this.entryName(key)
    const index = await this.open()
    const entry: StoredEntry = {
      ...key,
      version: this.version,
      digest: factsDigest(facts),
      facts,
    }
    const text = JSON.stringify(entry)
    const bytes = Buffer.byteLength(text)
    if (bytes > this.options.maxBytes) return
    const now = this.now()
    await this.options.files.writeFile(this.file(name), text)
    await this.touch(name, now)
    this.forget(index, name)
    index.set(name, { bytes, used: now, persisted: now })
    this.totalBytes += bytes
    this.entries = index.size
    await this.evict(index)
  }

  stats(): ModuleFactsCacheStats {
    return { ...this.counts, entries: this.entries, bytes: this.totalBytes }
  }

  private entryName(key: ModuleFactsKey): string {
    if (!BLOB.test(key.blob))
      throw new Error(`Invalid blob id for the parse cache: ${key.blob}`)
    if (!KIND.test(key.kind))
      throw new Error(`Invalid parse kind for the parse cache: ${key.kind}`)
    const namespace = hash(`${key.hostId}\0${key.repository}`).slice(0, 32)
    return `${namespace}-${key.blob}${key.kind}.json`
  }

  private file(name: string): HostPath {
    return localPath(posix.join(this.root, name))
  }

  private async touch(name: string, now: number): Promise<void> {
    await this.options.files.fileTransfer.setMetadata(this.file(name), {
      mode: 0o644,
      mtimeSeconds: now / 1000,
    })
  }

  private miss(): undefined {
    this.counts = { ...this.counts, misses: this.counts.misses + 1 }
    return undefined
  }

  /** Reads and validates one entry; a bad entry is deleted rather than trusted. */
  private async readEntry(
    name: string,
    key: ModuleFactsKey,
  ): Promise<ModuleFacts | undefined> {
    const index = await this.open()
    let text: string
    try {
      text = (await this.options.files.readFile(this.file(name))).toString('utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
      this.forget(index, name)
      return undefined
    }
    const entry = parseEntry(text)
    if (entry && this.matches(entry, key)) return entry.facts
    this.forget(index, name)
    await this.remove(name)
    this.counts = { ...this.counts, discarded: this.counts.discarded + 1 }
    return undefined
  }

  private matches(entry: StoredEntry, key: ModuleFactsKey): boolean {
    return (
      entry.version === this.version &&
      entry.hostId === key.hostId &&
      entry.repository === key.repository &&
      entry.blob === key.blob &&
      entry.kind === key.kind &&
      entry.digest === factsDigest(entry.facts)
    )
  }

  private forget(index: Map<string, IndexEntry>, name: string): void {
    const known = index.get(name)
    if (!known) return
    index.delete(name)
    this.totalBytes -= known.bytes
    this.entries = index.size
  }

  private async remove(name: string): Promise<void> {
    await this.options.files.removeFile(this.file(name)).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }

  /** Victims leave the index before any removal awaits, so concurrent stores agree. */
  private async evict(index: Map<string, IndexEntry>): Promise<void> {
    if (this.totalBytes <= this.options.maxBytes) return
    const victims: string[] = []
    const oldest = [...index].sort((left, right) => left[1].used - right[1].used)
    for (const [name] of oldest) {
      if (this.totalBytes <= this.options.maxBytes) break
      this.forget(index, name)
      victims.push(name)
    }
    for (const name of victims) await this.remove(name)
  }

  private open(): Promise<Map<string, IndexEntry>> {
    this.opened ??= this.load()
    return this.opened
  }

  /** First use drops other scanner versions and indexes this version's entries. */
  private async load(): Promise<Map<string, IndexEntry>> {
    await this.ensureDirectory(this.options.directory)
    await this.ensureDirectory(this.root)
    await this.dropOtherVersions()
    const index = new Map<string, IndexEntry>()
    for (const entry of await this.options.files.readdir(localPath(this.root))) {
      if (entry.type !== 'file' || !ENTRY.test(entry.name)) {
        await this.removeTree(posix.join(this.root, entry.name))
        continue
      }
      const status = await this.options.files.stat(this.file(entry.name))
      index.set(entry.name, {
        bytes: status.size,
        used: status.mtimeMs,
        persisted: status.mtimeMs,
      })
      this.totalBytes += status.size
    }
    this.entries = index.size
    await this.evict(index)
    return index
  }

  private async ensureDirectory(path: string): Promise<void> {
    await this.options.files
      .createDirectoryExclusive(localPath(path), { mode: 0o755 })
      .catch((error: unknown) => {
        if ((error as { code?: unknown } | undefined)?.code !== 'EEXIST') throw error
      })
  }

  private async dropOtherVersions(): Promise<void> {
    for (const entry of await this.options.files.readdir(
      localPath(this.options.directory),
    )) {
      const path = posix.join(this.options.directory, entry.name)
      if (path !== this.root) await this.removeTree(path)
    }
  }

  /** Removes a file, or a directory and everything under it, inside the cache. */
  private async removeTree(path: string): Promise<void> {
    const status = await this.options.files.stat(localPath(path))
    if (status.type !== 'dir') {
      await this.options.files.removeFile(localPath(path))
      return
    }
    for (const entry of await this.options.files.readdir(localPath(path)))
      await this.removeTree(posix.join(path, entry.name))
    await this.options.files.fileTransfer.removeDirectory(localPath(path))
  }
}

function parseEntry(text: string): StoredEntry | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Unparseable bytes are one of the corruptions the caller discards and reparses.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Partial<Record<keyof StoredEntry, unknown>>
  const strings = [
    entry.version,
    entry.hostId,
    entry.repository,
    entry.blob,
    entry.kind,
    entry.digest,
  ]
  if (!strings.every((field) => typeof field === 'string')) return undefined
  return isModuleFacts(entry.facts) ? (entry as StoredEntry) : undefined
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT'
}
