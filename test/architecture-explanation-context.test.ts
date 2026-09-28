import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readArchitectureExplanationContext } from '../src/main/architecture-review/explanation-context'
import { LocalHost } from '../src/main/project-host/local-host'
import { ARCHITECTURE_LIVE_REVISION } from '../src/shared/architecture-review'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
const signal = () => new AbortController().signal
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-explanation-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  const commit = async (path: string, content: string, message: string) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
    git(root, 'add', '.')
    git(root, 'commit', '-m', message)
    return git(root, 'rev-parse', 'HEAD')
  }
  return { root, commit, host: new LocalHost() }
}

it('lists commits and diffs between two commits', async () => {
  const r = await repository()
  const m1 = await r.commit('m1.ts', 'export const m1 = 1\n', 'add m1')
  const m2 = await r.commit('m2.ts', 'export const m2 = 1\n', 'add m2')
  const context = await readArchitectureExplanationContext(
    r.host,
    { root: localPath(r.root), baselineRevision: m1, currentRevision: m2, scope: [] },
    signal(),
  )
  expect(context.commits).toEqual([{ revision: m2, subject: 'add m2' }])
  expect(context.commitsTruncated).toBe(false)
  expect(context.diff).toContain('+export const m2 = 1')
  expect(context.diffTruncated).toBe(false)
})

it('diffs the live working tree against the baseline, including uncommitted edits', async () => {
  const r = await repository()
  const m1 = await r.commit('m1.ts', 'export const m1 = 1\n', 'add m1')
  const m2 = await r.commit('m2.ts', 'export const m2 = 1\n', 'add m2')
  await writeFile(join(r.root, 'm2.ts'), 'export const m2 = 2\n')
  const context = await readArchitectureExplanationContext(
    r.host,
    {
      root: localPath(r.root),
      baselineRevision: m1,
      currentRevision: ARCHITECTURE_LIVE_REVISION,
      scope: [],
    },
    signal(),
  )
  expect(context.commits).toEqual([{ revision: m2, subject: 'add m2' }])
  expect(context.diff).toContain('+export const m2 = 2')
})

it('returns nothing, without calling git, when Baseline and Current are the same commit', async () => {
  const r = await repository()
  const m1 = await r.commit('m1.ts', 'export const m1 = 1\n', 'add m1')
  const exec = vi.spyOn(r.host, 'exec')
  const context = await readArchitectureExplanationContext(
    r.host,
    { root: localPath(r.root), baselineRevision: m1, currentRevision: m1, scope: [] },
    signal(),
  )
  expect(context).toEqual({
    commits: [],
    commitsTruncated: false,
    diff: '',
    diffTruncated: false,
  })
  expect(exec).not.toHaveBeenCalled()
})

it('scopes commits and the diff to the given paths', async () => {
  const r = await repository()
  const m1 = await r.commit('m1.ts', 'export const m1 = 1\n', 'add m1')
  await r.commit('sub/a.ts', 'export const a = 1\n', 'add a')
  const inScope = await r.commit('sub/b.ts', 'export const b = 1\n', 'add b')
  const context = await readArchitectureExplanationContext(
    r.host,
    {
      root: localPath(r.root),
      baselineRevision: m1,
      currentRevision: inScope,
      scope: ['sub/b.ts'],
    },
    signal(),
  )
  expect(context.commits).toEqual([{ revision: inScope, subject: 'add b' }])
  expect(context.diff).toContain('+export const b = 1')
  expect(context.diff).not.toContain('export const a = 1')
})

it('truncates a diff over the cap and says so', async () => {
  const r = await repository()
  const m1 = await r.commit('m1.ts', 'export const m1 = 1\n', 'add m1')
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i} filler filler filler`).join(
    '\n',
  )
  const m2 = await r.commit('big.ts', `${big}\n`, 'add big')
  const context = await readArchitectureExplanationContext(
    r.host,
    { root: localPath(r.root), baselineRevision: m1, currentRevision: m2, scope: [] },
    signal(),
  )
  expect(context.diffTruncated).toBe(true)
  expect(context.diff.length).toBeGreaterThan(0)
  expect(context.diff).not.toContain('line 3999')
})

it('refuses foreign hosts without calling git', async () => {
  const r = await repository()
  const m1 = await r.commit('m1.ts', 'export const m1 = 1\n', 'add m1')
  const exec = vi.spyOn(r.host, 'exec')
  await expect(
    readArchitectureExplanationContext(
      r.host,
      {
        root: hostPath(asHostId('ssh'), r.root),
        baselineRevision: m1,
        currentRevision: ARCHITECTURE_LIVE_REVISION,
        scope: [],
      },
      signal(),
    ),
  ).rejects.toThrow(/workspace/)
  expect(exec).not.toHaveBeenCalled()
})
