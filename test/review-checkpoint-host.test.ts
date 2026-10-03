import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host'
import { localPath } from '../src/shared'
import { ReviewCheckpointHost } from '../src/main/git/review-checkpoint-host'
import type {
  ReviewCheckpointInspection,
  ReviewCheckpointObject,
} from '../src/shared/review-checkpoint'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'hvir-review-checkpoint-host-'))
  cleanups.push(() => rm(path, { recursive: true }))
  const git = (args: readonly string[]) =>
    execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Checkpoint Test'])
  git(['config', 'user.email', 'checkpoint@example.invalid'])
  await writeFile(join(path, 'file.bin'), Buffer.from([0, 255, 1, 13, 10]))
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  const host = new LocalHost()
  const authority = { projectId: 'test', root: localPath(path), host }
  const broker = new ReviewCheckpointHost()
  cleanups.push(async () => {
    broker.dispose()
    await host.dispose()
  })
  return { path, git, authority, broker }
}

describe('checkpoint host transport and private write confinement', () => {
  it('writes raw objects and one private ref without changing HEAD or index', async () => {
    const { path, git, authority, broker } = await fixture()
    const index = await readFile(join(path, '.git/index'))
    const head = git(['rev-parse', 'HEAD'])
    git(['config', 'filter.forbidden.clean', 'false'])
    await writeFile(join(path, '.gitattributes'), '* filter=forbidden\n')
    await writeFile(join(path, 'file.bin'), Buffer.from([2, 255, 0, 13, 10]))
    const grant = broker.begin(authority, 'capture')
    const inspect = (await broker.dispatch(grant.id, authority, {
      action: 'inspect',
    })) as ReviewCheckpointInspection
    expect(inspect.oid).toBeNull()
    await broker.dispatch(grant.id, authority, { action: 'files' })
    const blob = (await broker.dispatch(grant.id, authority, {
      action: 'hash',
      relativePath: 'file.bin',
      write: true,
    })) as ReviewCheckpointObject
    const tree = (await broker.dispatch(grant.id, authority, {
      action: 'write-tree',
      entries: [{ name: 'file.bin', ...blob }],
    })) as string
    await broker.dispatch(grant.id, authority, {
      action: 'update-ref',
      oid: tree,
      previous: null,
    })
    expect(git(['cat-file', '-p', tree])).toContain(blob.oid)
    expect(execFileSync('git', ['-C', path, 'cat-file', 'blob', blob.oid])).toEqual(
      Buffer.from([2, 255, 0, 13, 10]),
    )
    expect(git(['rev-parse', 'HEAD'])).toBe(head)
    expect(await readFile(join(path, '.git/index'))).toEqual(index)
    expect(
      git(['for-each-ref', '--format=%(refname)', 'refs/worktree/hvir-review/']),
    ).toMatch(/^refs\/worktree\/hvir-review\/[0-9a-f]{64}$/)
    await expect(
      broker.dispatch(grant.id, authority, {
        action: 'update-ref',
        oid: tree,
        previous: tree,
      }),
    ).rejects.toThrow()
    const read = broker.begin(authority, 'read')
    expect(
      await broker.dispatch(read.id, authority, { action: 'inspect' }),
    ).toMatchObject({ oid: tree })
    read.revoke()
  })

  it('does not create objects on read and denies tree/ref writes without capture', async () => {
    const { path, git, authority, broker } = await fixture()
    await writeFile(join(path, 'file.bin'), 'uncaptured bytes')
    const before = git(['count-objects', '-v'])
    const read = broker.begin(authority, 'read')
    await broker.dispatch(read.id, authority, { action: 'inspect' })
    await broker.dispatch(read.id, authority, { action: 'files' })
    await broker.dispatch(read.id, authority, {
      action: 'hash',
      relativePath: 'file.bin',
      write: false,
    })
    expect(git(['count-objects', '-v'])).toBe(before)
    await expect(
      broker.dispatch(read.id, authority, {
        action: 'hash',
        relativePath: 'file.bin',
        write: true,
      }),
    ).rejects.toThrow('capture')
    await expect(
      broker.dispatch('absent', authority, { action: 'write-tree', entries: [] }),
    ).rejects.toThrow()
  })

  it('refuses objects not produced by this capture and clear refuses CAS races', async () => {
    const { git, authority, broker } = await fixture()
    const capture = broker.begin(authority, 'capture')
    await broker.dispatch(capture.id, authority, { action: 'inspect' })
    await expect(
      broker.dispatch(capture.id, authority, {
        action: 'write-tree',
        entries: [
          { name: 'stolen', mode: '100644', oid: git(['rev-parse', 'HEAD:file.bin']) },
        ],
      }),
    ).rejects.toThrow('capture')
    const clear = broker.begin(authority, 'clear')
    await expect(
      broker.dispatch(clear.id, authority, {
        action: 'clear-ref',
        previous: 'a'.repeat(40),
      }),
    ).rejects.toThrow()
    expect(
      git(['for-each-ref', '--format=%(refname)', 'refs/worktree/hvir-review/']),
    ).toBe('')
  })

  it('fails closed on sparse checkouts and cross-project dispatch', async () => {
    const { git, authority, broker } = await fixture()
    const read = broker.begin(authority, 'read')
    await expect(
      broker.dispatch(read.id, { ...authority, projectId: 'other' }, { action: 'files' }),
    ).rejects.toThrow()
    git(['config', 'core.sparseCheckout', 'true'])
    await expect(
      broker.dispatch(read.id, authority, { action: 'inspect' }),
    ).rejects.toThrow('Sparse')
  })
})
