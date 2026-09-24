import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModuleFactsCache,
  type ModuleFactsCacheOptions,
  type ModuleFactsKey,
} from '../src/main/architecture-review/module-facts-cache'
import { LocalHost } from '../src/main/project-host/local-host'
import {
  ARCHITECTURE_SCANNER_VERSION,
  parseModuleFacts,
} from '../src/main/architecture-review/module-facts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-facts-cache-'))
  directories.push(directory)
  return directory
}

const files = new LocalHost()
const openCache = (options: Omit<ModuleFactsCacheOptions, 'files'>) =>
  new ModuleFactsCache({ ...options, files })

const key = (blob: string, patch: Partial<ModuleFactsKey> = {}): ModuleFactsKey => ({
  hostId: 'local',
  repository: '/repo',
  blob,
  kind: '.ts',
  ...patch,
})
const facts = parseModuleFacts('a.ts', "import './b'\nexport function a() {}\n")
const blobA = 'a'.repeat(40)
const blobB = 'b'.repeat(40)
const blobC = 'c'.repeat(40)

async function entryFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

describe('architecture parse cache on disk', () => {
  it('returns stored facts to a later cache opened on the same directory', async () => {
    const directory = await cacheDirectory()
    const first = openCache({ directory, maxBytes: 1024 * 1024 })
    expect(await first.lookup(key(blobA))).toBeUndefined()
    await first.store(key(blobA), facts)
    const second = openCache({ directory, maxBytes: 1024 * 1024 })
    expect(await second.lookup(key(blobA))).toEqual(facts)
    expect(second.stats()).toMatchObject({ hits: 1, misses: 0, discarded: 0 })
  })

  it('keys entries by host, repository, blob id and parse kind', async () => {
    const directory = await cacheDirectory()
    const cache = openCache({ directory, maxBytes: 1024 * 1024 })
    await cache.store(key(blobA), facts)
    expect(await cache.lookup(key(blobA, { hostId: 'ssh:other' }))).toBeUndefined()
    expect(await cache.lookup(key(blobA, { repository: '/other' }))).toBeUndefined()
    expect(await cache.lookup(key(blobB))).toBeUndefined()
    expect(await cache.lookup(key(blobA, { kind: '.tsx' }))).toBeUndefined()
    expect(await cache.lookup(key(blobA))).toEqual(facts)
  })

  it('keeps entries under a scanner version and drops other versions when opened', async () => {
    const directory = await cacheDirectory()
    const stale = join(directory, 'scanner-old', 'namespace')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'entry.json'), '{}')
    const cache = openCache({ directory, maxBytes: 1024 * 1024 })
    await cache.store(key(blobA), facts)
    const files = await entryFiles(directory)
    expect(files).toHaveLength(1)
    expect(await readFile(files[0]!, 'utf8')).toContain(ARCHITECTURE_SCANNER_VERSION)
    expect(files.some((file) => file.includes('scanner-old'))).toBe(false)
    const upgraded = openCache({
      directory,
      maxBytes: 1024 * 1024,
      scannerVersion: `${ARCHITECTURE_SCANNER_VERSION}-next`,
    })
    expect(await upgraded.lookup(key(blobA))).toBeUndefined()
    expect(await entryFiles(directory)).toEqual([])
  })

  it('evicts the least recently used entries to stay within its byte budget', async () => {
    const directory = await cacheDirectory()
    const probe = openCache({ directory, maxBytes: 1024 * 1024 })
    await probe.store(key(blobA), facts)
    const entryBytes = (await stat((await entryFiles(directory))[0]!)).size
    await rm(directory, { recursive: true, force: true })
    let now = 1_000
    const cache = openCache({
      directory,
      maxBytes: entryBytes * 2 + 10,
      now: () => (now += 1_000),
    })
    await cache.store(key(blobA), facts)
    await cache.store(key(blobB), facts)
    expect(await cache.lookup(key(blobA))).toEqual(facts)
    await cache.store(key(blobC), facts)
    expect(cache.stats().bytes).toBeLessThanOrEqual(entryBytes * 2 + 10)
    expect(await cache.lookup(key(blobB))).toBeUndefined()
    expect(await cache.lookup(key(blobA))).toEqual(facts)
    expect(await cache.lookup(key(blobC))).toEqual(facts)
    expect(await entryFiles(directory)).toHaveLength(2)
  })

  it('restores recency from disk so a new process evicts the oldest entry', async () => {
    const directory = await cacheDirectory()
    // Hours apart, so each hit is persisted rather than held only in memory.
    let now = 1_000_000_000_000
    const clock = () => (now += 2 * 60 * 60 * 1000)
    const writer = openCache({ directory, maxBytes: 1024 * 1024, now: clock })
    await writer.store(key(blobA), facts)
    await writer.store(key(blobB), facts)
    expect(await writer.lookup(key(blobA))).toEqual(facts)
    const entryBytes = writer.stats().bytes / 2
    const reader = openCache({
      directory,
      maxBytes: Math.floor(entryBytes * 2.5),
      now: clock,
    })
    await reader.store(key(blobC), facts)
    expect(await reader.lookup(key(blobB))).toBeUndefined()
    expect(await reader.lookup(key(blobA))).toEqual(facts)
  })

  it('does not store an entry larger than the whole budget', async () => {
    const directory = await cacheDirectory()
    const cache = openCache({ directory, maxBytes: 16 })
    await cache.store(key(blobA), facts)
    expect(await cache.lookup(key(blobA))).toBeUndefined()
    expect(await entryFiles(directory)).toEqual([])
  })

  it.each([
    ['truncated JSON', (text: string) => text.slice(0, text.length / 2)],
    [
      'facts that no longer match their digest',
      (text: string) => text.replace('./b', './c'),
    ],
    [
      'a structurally invalid entry with a matching shape',
      () => JSON.stringify({ version: ARCHITECTURE_SCANNER_VERSION, facts: [] }),
    ],
    ['an empty file', () => ''],
  ])('discards %s and reports a miss', async (_label, corrupt) => {
    const directory = await cacheDirectory()
    const cache = openCache({ directory, maxBytes: 1024 * 1024 })
    await cache.store(key(blobA), facts)
    const [file] = await entryFiles(directory)
    await writeFile(file!, corrupt(await readFile(file!, 'utf8')))
    const reopened = openCache({ directory, maxBytes: 1024 * 1024 })
    expect(await reopened.lookup(key(blobA))).toBeUndefined()
    expect(reopened.stats()).toMatchObject({ hits: 0, misses: 1, discarded: 1 })
    expect(await entryFiles(directory)).toEqual([])
    await reopened.store(key(blobA), facts)
    expect(await reopened.lookup(key(blobA))).toEqual(facts)
  })

  it('refuses a key that could name a path outside the cache', async () => {
    const directory = await cacheDirectory()
    const cache = openCache({ directory, maxBytes: 1024 * 1024 })
    await expect(cache.lookup(key('../../etc/passwd'))).rejects.toThrow(/blob id/)
    await expect(cache.lookup(key(blobA, { kind: '/x' }))).rejects.toThrow(/kind/)
  })
})
