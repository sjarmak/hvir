import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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
  const path = await mkdtemp(join(tmpdir(), 'hvir-review-checkpoint-security-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  const git = (args: readonly string[]) =>
    execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Checkpoint Security Test'])
  git(['config', 'user.email', 'checkpoint-security@example.invalid'])
  await writeFile(join(path, 'file.txt'), 'initial')
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  const host = new LocalHost()
  const authority = { projectId: 'security', root: localPath(path), host }
  const broker = new ReviewCheckpointHost()
  cleanups.push(async () => {
    broker.dispose()
    await host.dispose()
  })
  return { path, git, host, authority, broker }
}

describe('checkpoint host authority and raw IO security', () => {
  it('rejects replay through another host instance and revokes the grant', async () => {
    const { authority, broker } = await fixture()
    const otherHost = new LocalHost()
    cleanups.push(() => otherHost.dispose())
    const grant = broker.begin(authority, 'read')
    await expect(
      broker.dispatch(grant.id, { ...authority, host: otherHost }, { action: 'inspect' }),
    ).rejects.toThrow('host authority changed')
    await expect(
      broker.dispatch(grant.id, authority, { action: 'inspect' }),
    ).rejects.toThrow()
    grant.revoke()
  })

  it('cancels an in-flight bounded read before it can hash or publish an object', async () => {
    const { git, host, authority, broker } = await fixture()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const transfer = host.fileTransfer
    ;(host as { fileTransfer: typeof transfer }).fileTransfer = {
      ...transfer,
      readFileChunks: async function* (_path, options) {
        await blocked
        options?.signal?.throwIfAborted()
        yield Buffer.from('initial')
      },
    }
    const grant = broker.begin(authority, 'capture')
    await broker.dispatch(grant.id, authority, { action: 'inspect' })
    await broker.dispatch(grant.id, authority, { action: 'files' })
    const before = git(['count-objects', '-v'])
    const pending = broker.dispatch(grant.id, authority, {
      action: 'hash',
      relativePath: 'file.txt',
      write: true,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    grant.revoke()
    release()
    await expect(pending).rejects.toThrow()
    expect(git(['count-objects', '-v'])).toBe(before)
  })

  it('confines ref updates to produced trees and disables hooks for the raw capture', async () => {
    const { path, git, authority, broker } = await fixture()
    const hooks = join(path, 'hooks')
    const marker = join(path, 'hook-ran')
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'reference-transaction'),
      `#!/bin/sh\nprintf x > ${marker}\n`,
    )
    await chmod(join(hooks, 'reference-transaction'), 0o755)
    git(['config', 'core.hooksPath', hooks])
    const grant = broker.begin(authority, 'capture')
    const inspect = (await broker.dispatch(grant.id, authority, {
      action: 'inspect',
    })) as ReviewCheckpointInspection
    await broker.dispatch(grant.id, authority, { action: 'files' })
    const blob = (await broker.dispatch(grant.id, authority, {
      action: 'hash',
      relativePath: 'file.txt',
      write: true,
    })) as ReviewCheckpointObject
    const tree = (await broker.dispatch(grant.id, authority, {
      action: 'write-tree',
      entries: [{ name: 'file.txt', mode: '100644', oid: blob.oid }],
    })) as string
    await broker.dispatch(grant.id, authority, {
      action: 'update-ref',
      oid: tree,
      previous: inspect.oid,
    })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    const invalid = broker.begin(authority, 'capture')
    await broker.dispatch(invalid.id, authority, { action: 'inspect' })
    await broker.dispatch(invalid.id, authority, { action: 'files' })
    const invalidBlob = (await broker.dispatch(invalid.id, authority, {
      action: 'hash',
      relativePath: 'file.txt',
      write: true,
    })) as ReviewCheckpointObject
    await expect(
      broker.dispatch(invalid.id, authority, {
        action: 'update-ref',
        oid: invalidBlob.oid,
        previous: tree,
      }),
    ).rejects.toThrow('produced by this capture')

    const malformed = broker.begin(authority, 'capture')
    await broker.dispatch(malformed.id, authority, { action: 'inspect' })
    await broker.dispatch(malformed.id, authority, { action: 'files' })
    const malformedBlob = (await broker.dispatch(malformed.id, authority, {
      action: 'hash',
      relativePath: 'file.txt',
      write: true,
    })) as ReviewCheckpointObject
    await expect(
      broker.dispatch(malformed.id, authority, {
        action: 'write-tree',
        entries: [{ name: '../escape', mode: '100644', oid: malformedBlob.oid }],
      }),
    ).rejects.toThrow('Invalid checkpoint tree name')
  })
})
