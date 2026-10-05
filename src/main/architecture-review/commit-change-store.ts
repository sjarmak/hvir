import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { ArchitectureCommitChange } from '../../shared/architecture-review'
import { localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { CommitChangeKey } from './commit-change-cache'

export const COMMIT_CHANGE_STORE_FORMAT = 'commit-change-store-1'
export const COMMIT_CHANGE_STORE_ENTRIES_PER_REPOSITORY = 60_000
export const COMMIT_CHANGE_STORE_REPOSITORIES = 16
const FLUSH_DELAY_MS = 2_000

export type CommitChangeStoreFiles = Pick<
  ProjectHost,
  'readFile' | 'writeFile' | 'removeFile' | 'readdir' | 'createDirectoryExclusive'
>

export interface CommitChangeStoreOptions {
  readonly files: CommitChangeStoreFiles
  readonly directory: string
  readonly entriesPerRepository?: number
  readonly repositories?: number
  readonly flushDelayMs?: number
  readonly now?: () => number
}

type StoredChange = Exclude<ArchitectureCommitChange, 'unclassified'>

interface RepositoryFile {
  readonly format: string
  readonly hostId: string
  readonly repository: string
  readonly used: number
  readonly entries: Readonly<Record<string, StoredChange>>
}

interface Repository {
  readonly root: HostPath
  readonly entries: Map<string, StoredChange>
  dirty: boolean
}

const STORED_CHANGES: ReadonlySet<string> = new Set(['architecture', 'code', 'none'])
const ENTRY_KEY =
  /^(?:[a-f0-9]{40}|[a-f0-9]{64}):(?:[a-f0-9]{40}|[a-f0-9]{64})?:[a-f0-9]{16}$/
const FILE = /^[a-f0-9]{32}\.json$/
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export class CommitChangeStore {
  private readonly root: string
  private readonly perRepository: number
  private readonly repositoryLimit: number
  private readonly flushDelayMs: number
  private readonly now: () => number
  private readonly repositories = new Map<string, Promise<Repository>>()
  private readonly settled = new Map<string, Repository>()
  private prepared: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> = Promise.resolve()

  constructor(private readonly options: CommitChangeStoreOptions) {
    if (!posix.isAbsolute(options.directory))
      throw new Error('Commit classification store needs an absolute directory')
    this.root = posix.join(
      options.directory,
      `format-${hash(COMMIT_CHANGE_STORE_FORMAT).slice(0, 16)}`,
    )
    this.perRepository =
      options.entriesPerRepository ?? COMMIT_CHANGE_STORE_ENTRIES_PER_REPOSITORY
    this.repositoryLimit = options.repositories ?? COMMIT_CHANGE_STORE_REPOSITORIES
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.perRepository) || this.perRepository < 1)
      throw new Error('Commit classification store needs a positive entry bound')
    if (!Number.isSafeInteger(this.repositoryLimit) || this.repositoryLimit < 1)
      throw new Error('Commit classification store needs a positive repository bound')
  }

  async open(root: HostPath): Promise<void> {
    await this.repository(root)
  }

  lookup(key: CommitChangeKey): StoredChange | undefined {
    return this.loaded(key.root)?.entries.get(entryKey(key))
  }

  store(key: CommitChangeKey, change: ArchitectureCommitChange): void {
    if (change === 'unclassified') return
    const repository = this.loaded(key.root)
    if (!repository) return
    const name = entryKey(key)
    if (repository.entries.get(name) === change) return
    repository.entries.delete(name)
    repository.entries.set(name, change)
    while (repository.entries.size > this.perRepository) {
      const oldest = repository.entries.keys().next().value
      if (oldest === undefined) break
      repository.entries.delete(oldest)
    }
    repository.dirty = true
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.flushing = this.flushing.then(() => this.writeDirty())
    await this.flushing
  }

  private loaded(root: HostPath): Repository | undefined {
    return this.settled.get(repositoryId(root))
  }

  private repository(root: HostPath): Promise<Repository> {
    const id = repositoryId(root)
    let pending = this.repositories.get(id)
    if (!pending) {
      pending = this.read(root).then((repository) => {
        this.settled.set(id, repository)
        return repository
      })
      pending.catch(() => this.repositories.delete(id))
      this.repositories.set(id, pending)
    }
    return pending
  }

  private async read(root: HostPath): Promise<Repository> {
    await this.prepare()
    const empty: Repository = { root, entries: new Map(), dirty: false }
    let text: string
    try {
      text = (await this.options.files.readFile(this.file(root))).toString('utf8')
    } catch (error) {
      if (isMissing(error)) return empty
      throw error
    }
    const parsed = parseRepositoryFile(text)
    if (parsed?.hostId !== root.hostId || parsed.repository !== root.path) {
      await this.removeIfPresent(this.file(root))
      return empty
    }
    return { ...empty, entries: new Map(Object.entries(parsed.entries)) }
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushing = this.flushing
        .then(() => this.writeDirty())
        .catch((error: unknown) =>
          console.warn('[architecture-review] commit classification store write failed', error),
        )
    }, this.flushDelayMs)
    this.timer.unref?.()
  }

  private async writeDirty(): Promise<void> {
    for (const repository of this.settled.values()) {
      if (!repository.dirty) continue
      repository.dirty = false
      const file: RepositoryFile = {
        format: COMMIT_CHANGE_STORE_FORMAT,
        hostId: repository.root.hostId,
        repository: repository.root.path,
        used: this.now(),
        entries: Object.fromEntries(repository.entries),
      }
      try {
        await this.options.files.writeFile(
          this.file(repository.root),
          JSON.stringify(file),
        )
      } catch (error) {
        repository.dirty = true
        throw error
      }
    }
  }

  private prepare(): Promise<void> {
    this.prepared ??= this.ensureDirectories().catch((error: unknown) => {
      this.prepared = undefined
      throw error
    })
    return this.prepared
  }

  private async ensureDirectories(): Promise<void> {
    await this.ensureDirectory(this.options.directory)
    await this.ensureDirectory(this.root)
    for (const entry of await this.options.files.readdir(
      localPath(this.options.directory),
    )) {
      const path = posix.join(this.options.directory, entry.name)
      if (path !== this.root && entry.type === 'file')
        await this.removeIfPresent(localPath(path))
    }
    await this.evictRepositories()
  }

  private async evictRepositories(): Promise<void> {
    const files: { readonly name: string; readonly used: number }[] = []
    for (const entry of await this.options.files.readdir(localPath(this.root))) {
      if (entry.type !== 'file' || !FILE.test(entry.name)) continue
      const path = localPath(posix.join(this.root, entry.name))
      const text = await this.options.files.readFile(path).then(
        (bytes) => bytes.toString('utf8'),
        (error: unknown) => {
          if (isMissing(error)) return undefined
          throw error
        },
      )
      const parsed = text === undefined ? undefined : parseRepositoryFile(text)
      if (parsed) files.push({ name: entry.name, used: parsed.used })
      else await this.removeIfPresent(path)
    }
    const oldest = [...files].sort((left, right) => right.used - left.used)
    for (const victim of oldest.slice(this.repositoryLimit))
      await this.removeIfPresent(localPath(posix.join(this.root, victim.name)))
  }

  private file(root: HostPath): HostPath {
    return localPath(posix.join(this.root, `${repositoryId(root)}.json`))
  }

  private async ensureDirectory(path: string): Promise<void> {
    await this.options.files
      .createDirectoryExclusive(localPath(path), { mode: 0o755 })
      .catch((error: unknown) => {
        if ((error as { code?: unknown } | undefined)?.code !== 'EEXIST') throw error
      })
  }

  private async removeIfPresent(path: HostPath): Promise<void> {
    await this.options.files.removeFile(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
}

function repositoryId(root: HostPath): string {
  return hash(`${root.hostId}\0${root.path}`).slice(0, 32)
}

function entryKey(key: CommitChangeKey): string {
  const signature = hash(`${key.scanners}\0${key.layout}`).slice(0, 16)
  return `${key.revision}:${key.parent ?? ''}:${signature}`
}

function parseRepositoryFile(text: string): RepositoryFile | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const file = value as Partial<Record<keyof RepositoryFile, unknown>>
  if (
    file.format !== COMMIT_CHANGE_STORE_FORMAT ||
    typeof file.hostId !== 'string' ||
    typeof file.repository !== 'string' ||
    typeof file.used !== 'number' ||
    typeof file.entries !== 'object' ||
    file.entries === null
  )
    return undefined
  for (const [name, change] of Object.entries(file.entries)) {
    if (
      !ENTRY_KEY.test(name) ||
      typeof change !== 'string' ||
      !STORED_CHANGES.has(change)
    )
      return undefined
  }
  return file as RepositoryFile
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT'
}
