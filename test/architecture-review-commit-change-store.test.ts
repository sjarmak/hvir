import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommitChangeKey } from '../src/main/architecture-review/commit-change-cache'
import {
  CommitChangeStore,
  type CommitChangeStoreOptions,
} from '../src/main/architecture-review/commit-change-store'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function storeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-commit-change-store-'))
  directories.push(directory)
  return directory
}

const files = new LocalHost()
const openStore = (options: Omit<CommitChangeStoreOptions, 'files'>) =>
  new CommitChangeStore({ flushDelayMs: 60_000, ...options, files })

const sha = (n: number) => n.toString(16).padStart(40, '0')
const repo = localPath('/repo')
const key = (n: number, patch: Partial<CommitChangeKey> = {}): CommitChangeKey => ({
  root: repo,
  revision: sha(n),
  parent: sha(n + 1000),
  scanners: 'commit-change-4',
  layout: 'default',
  ...patch,
})

async function repositoryFiles(directory: string): Promise<string[]> {
  const [format] = await readdir(directory)
  return (await readdir(join(directory, format!))).map((name) =>
    join(directory, format!, name),
  )
}

describe('Commit classification store', () => {
  it('answers a classification from disk after a restart', async () => {
    const directory = await storeDirectory()
    const first = openStore({ directory })
    await first.open(repo)
    first.store(key(1), 'architecture')
    first.store(key(2), 'code')
    await first.flush()

    const second = openStore({ directory })
    expect(second.lookup(key(1))).toBeUndefined()
    await second.open(repo)
    expect(second.lookup(key(1))).toBe('architecture')
    expect(second.lookup(key(2))).toBe('code')
  })

  it('misses when the parent, scanners, layout, or repository differ', async () => {
    const directory = await storeDirectory()
    const store = openStore({ directory })
    await store.open(repo)
    store.store(key(1), 'architecture')

    expect(store.lookup(key(1, { parent: sha(5) }))).toBeUndefined()
    expect(store.lookup(key(1, { parent: null }))).toBeUndefined()
    expect(store.lookup(key(1, { scanners: 'commit-change-5' }))).toBeUndefined()
    expect(store.lookup(key(1, { layout: 'a'.repeat(40) }))).toBeUndefined()
    expect(store.lookup(key(1, { root: localPath('/other') }))).toBeUndefined()
  })

  it('never stores an unclassified commit', async () => {
    const directory = await storeDirectory()
    const store = openStore({ directory })
    await store.open(repo)
    store.store(key(1), 'unclassified')
    await store.flush()
    expect(store.lookup(key(1))).toBeUndefined()
    expect(await repositoryFiles(directory)).toEqual([])
  })

  it('keeps at most the bounded number of entries per repository, newest first', async () => {
    const directory = await storeDirectory()
    const store = openStore({ directory, entriesPerRepository: 2 })
    await store.open(repo)
    store.store(key(1), 'code')
    store.store(key(2), 'code')
    store.store(key(3), 'none')
    expect(store.lookup(key(1))).toBeUndefined()
    expect(store.lookup(key(3))).toBe('none')
  })

  it('discards a corrupt or foreign repository file and starts empty', async () => {
    const directory = await storeDirectory()
    const store = openStore({ directory })
    await store.open(repo)
    store.store(key(1), 'code')
    await store.flush()
    const [file] = await repositoryFiles(directory)
    const stored = JSON.parse(await readFile(file!, 'utf8')) as Record<string, unknown>
    await writeFile(file!, JSON.stringify({ ...stored, entries: { bad: 'code' } }))

    const reopened = openStore({ directory })
    await reopened.open(repo)
    expect(reopened.lookup(key(1))).toBeUndefined()
    expect(await repositoryFiles(directory)).toEqual([])
  })

  it('evicts the least recently written repositories past the bound', async () => {
    const directory = await storeDirectory()
    let clock = 1
    const store = openStore({ directory, now: () => clock })
    for (const path of ['/a', '/b', '/c']) {
      const root = localPath(path)
      await store.open(root)
      store.store(key(1, { root }), 'code')
      await store.flush()
      clock += 1
    }

    const bounded = openStore({ directory, repositories: 2 })
    await bounded.open(localPath('/c'))
    expect(await repositoryFiles(directory)).toHaveLength(2)
    await bounded.open(localPath('/a'))
    expect(bounded.lookup(key(1, { root: localPath('/a') }))).toBeUndefined()
    expect(bounded.lookup(key(1, { root: localPath('/c') }))).toBe('code')
  })
})
