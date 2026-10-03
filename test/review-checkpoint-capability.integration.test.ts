import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ReviewCheckpointCapability } from '../src/main/git/review-checkpoint-capability'
import { ReviewCheckpointHost } from '../src/main/git/review-checkpoint-host'
import { LocalHost } from '../src/main/project-host'
import { localPath } from '../src/shared'
import type {
  ReviewCheckpointHostRequest,
  ReviewCheckpointHostResult,
} from '../src/shared/review-checkpoint'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('ReviewCheckpointCapability with real git', () => {
  it('captures raw workspace state, persists across restart, and produces exact diffs', async () => {
    const fixture = await makeRepository()
    const baselineHead = fixture.git(['rev-parse', 'HEAD'])
    const baselineIndex = await readFile(join(fixture.path, '.git/index'))
    const first = await (await fixture.capability('capture')).capture()
    expect(first.changes).toEqual([])
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(baselineHead)
    expect(await readFile(join(fixture.path, '.git/index'))).toEqual(baselineIndex)

    await writeFile(join(fixture.path, 'base.txt'), 'changed\n')
    await writeFile(join(fixture.path, 'staged.txt'), 'staged-live\n')
    fixture.git(['add', 'staged.txt'])
    await writeFile(join(fixture.path, 'deleted.txt'), 'gone\n')
    await rm(join(fixture.path, 'deleted.txt'))
    await writeFile(join(fixture.path, 'new.txt'), 'new\n')
    await chmod(join(fixture.path, 'exec.sh'), 0o755)
    await rm(join(fixture.path, 'link'))
    await symlink('/outside/checkpoint-target', join(fixture.path, 'link'))
    await writeFile(join(fixture.path, 'ignored.txt'), 'ignored\n')

    const after = await (await fixture.capability('read')).status()
    const names = after.changes.map((change) =>
      change.path.path.slice(fixture.path.length + 1),
    )
    expect(names).toEqual([
      'base.txt',
      'deleted.txt',
      'exec.sh',
      'link',
      'new.txt',
      'staged.txt',
    ])
    expect(names).not.toContain('ignored.txt')
    const baseChange = after.changes.find((change) =>
      change.path.path.endsWith('/base.txt'),
    )!
    const diff = await fixture
      .capability('read')
      .then((capability) => capability.diff(after.oid!, baseChange))
    expect(diff.baseInput.content).toBe('base\n')
    expect(diff.currentInput.content).toBe('changed\n')

    await writeFile(join(fixture.path, 'base.txt'), 'stale\n')
    await expect(
      fixture
        .capability('read')
        .then((capability) => capability.diff(after.oid!, baseChange)),
    ).rejects.toThrow('changed')
    expect(fixture.git(['cat-file', '-e', `${after.oid}^{tree}`])).toBe('')

    const restarted = await fixture.capability('read')
    await expect(restarted.status()).resolves.toMatchObject({ oid: first.oid })
    fixture.git(['checkout', '-qb', 'other'])
    await expect(restarted.status()).resolves.toMatchObject({ oid: first.oid })
    await (await fixture.capability('clear')).clear()
    expect(
      fixture.git(['for-each-ref', '--format=%(refname)', 'refs/worktree/hvir-review/']),
    ).toBe('')
  })

  it('rejects a capture when the live workspace changes and preserves the old baseline', async () => {
    const fixture = await makeRepository()
    const initial = await (await fixture.capability('capture')).capture()
    let filesCalls = 0
    const capability = await fixture.capability('capture', async (request, dispatch) => {
      const result = await dispatch(request)
      if (request.action === 'files' && ++filesCalls === 2)
        await writeFile(join(fixture.path, 'base.txt'), 'mutated during capture\n')
      return result
    })
    await expect(capability.capture()).rejects.toThrow('changed')
    await expect(
      fixture.capability('read').then((item) => item.status()),
    ).resolves.toMatchObject({
      oid: initial.oid,
    })
  })

  it('isolates a subdirectory capture from its sibling files', async () => {
    const fixture = await makeRepository()
    await mkdir(join(fixture.path, 'sub'))
    await writeFile(join(fixture.path, 'sub', 'inside.txt'), 'inside\n')
    await writeFile(join(fixture.path, 'sibling.txt'), 'sibling\n')
    fixture.git(['add', 'sub/inside.txt', 'sibling.txt'])
    fixture.git(['commit', '-qm', 'subtree'])
    const subRoot = localPath(join(fixture.path, 'sub'))
    const host = new LocalHost()
    const broker = new ReviewCheckpointHost()
    const authority = { projectId: 'sub', root: subRoot, host }
    const grant = broker.begin(authority, 'capture')
    const capability = new ReviewCheckpointCapability(
      { call: (request) => broker.dispatch(grant.id, authority, request) },
      subRoot,
    )
    try {
      const saved = await capability.capture()
      expect(saved.changes).toEqual([])
      expect(fixture.git(['ls-tree', '-r', '--name-only', saved.oid!])).toBe('inside.txt')
      await expect(
        fixture.capability('read').then((item) => item.status()),
      ).resolves.toMatchObject({ oid: null })
    } finally {
      grant.revoke()
      broker.dispose()
      await host.dispose()
    }
  })

  it('keeps linked worktree baselines independent through advance and clear', async () => {
    const fixture = await makeRepository()
    const first = await (await fixture.capability('capture')).capture()
    const linkedParent = await mkdtemp(join(tmpdir(), 'hvir-checkpoint-linked-'))
    cleanups.push(() => rm(linkedParent, { recursive: true, force: true }))
    const linkedPath = join(linkedParent, 'workspace')
    fixture.git(['worktree', 'add', '-qb', 'linked', linkedPath])
    const atLinked = (kind: 'read' | 'capture' | 'clear') => {
      const item = capabilityFor(linkedPath, kind)
      cleanups.push(item.dispose)
      return item.capability
    }
    await expect(atLinked('read').status()).resolves.toMatchObject({ oid: null })
    await writeFile(join(linkedPath, 'base.txt'), 'linked content\n')
    const linked = await atLinked('capture').capture()
    expect(linked.oid).not.toBe(first.oid)
    await expect(
      fixture.capability('read').then((item) => item.status()),
    ).resolves.toMatchObject({ oid: first.oid, changes: [] })
    await atLinked('clear').clear()
    await expect(atLinked('read').status()).resolves.toMatchObject({ oid: null })
    await expect(
      fixture.capability('read').then((item) => item.status()),
    ).resolves.toMatchObject({ oid: first.oid, changes: [] })
  })

  it('does not invoke configured hooks or filters while hashing workspace bytes', async () => {
    const fixture = await makeRepository()
    const filter = join(fixture.path, 'filter.sh')
    const filterMarker = join(fixture.path, 'filter-marker')
    const hookMarker = join(fixture.path, 'hook-marker')
    await writeFile(filter, `#!/bin/sh\nprintf invoked > ${filterMarker}\n`)
    await chmod(filter, 0o755)
    fixture.git(['config', 'filter.checkpoint.clean', `sh ${filter}`])
    await writeFile(join(fixture.path, '.gitattributes'), 'base.txt filter=checkpoint\n')
    await mkdir(join(fixture.path, '.hooks'))
    const hook = join(fixture.path, '.hooks', 'pre-commit')
    await writeFile(hook, `#!/bin/sh\nprintf invoked > ${hookMarker}\n`)
    await chmod(hook, 0o755)
    fixture.git(['config', 'core.hooksPath', '.hooks'])
    await (await fixture.capability('capture')).capture()
    await expect(readFile(filterMarker)).rejects.toThrow()
    await expect(readFile(hookMarker)).rejects.toThrow()
  })
})

async function makeRepository() {
  const path = await mkdtemp(join(tmpdir(), 'hvir-review-checkpoint-capability-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  const git = (args: readonly string[]) =>
    execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Checkpoint Test'])
  git(['config', 'user.email', 'checkpoint@example.invalid'])
  git(['config', 'core.autocrlf', 'false'])
  await writeFile(join(path, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(path, 'base.txt'), 'base\n')
  await writeFile(join(path, 'deleted.txt'), 'gone\n')
  await writeFile(join(path, 'staged.txt'), 'staged\n')
  await writeFile(join(path, 'exec.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(path, 'exec.sh'), 0o644)
  await symlink('/outside/original-target', join(path, 'link'))
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  const capability = async (
    kind: 'capture' | 'read' | 'clear',
    intercept?: Parameters<typeof capabilityFor>[2],
  ) => {
    const item = capabilityFor(path, kind, intercept)
    cleanups.push(item.dispose)
    return await Promise.resolve(item.capability)
  }
  return { path, git, capability }
}

function capabilityFor(
  path: string,
  kind: 'capture' | 'read' | 'clear',
  intercept?: (
    request: ReviewCheckpointHostRequest,
    dispatch: (
      request: ReviewCheckpointHostRequest,
    ) => Promise<ReviewCheckpointHostResult>,
  ) => Promise<ReviewCheckpointHostResult>,
) {
  const host = new LocalHost()
  const broker = new ReviewCheckpointHost()
  const authority = { projectId: 'integration', root: localPath(path), host }
  const grant = broker.begin(authority, kind)
  const dispatch = (request: ReviewCheckpointHostRequest) =>
    broker.dispatch(grant.id, authority, request)
  return {
    capability: new ReviewCheckpointCapability(
      {
        call: (request) => (intercept ? intercept(request, dispatch) : dispatch(request)),
      },
      authority.root,
    ),
    dispose: async () => {
      grant.revoke()
      broker.dispose()
      await host.dispose()
    },
  }
}
