import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { listArchitectureCommits } from '../src/main/architecture-review/commit-range'
import { LocalHost } from '../src/main/project-host/local-host'
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
/** main: m1, m2; feature from m2: f1, merge of side, f2. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-strip-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  const commit = async (name: string) => {
    await writeFile(join(root, `${name}.ts`), `export const ${name} = 1\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-m', `add ${name}`)
    return git(root, 'rev-parse', 'HEAD')
  }
  const m1 = await commit('m1')
  const m2 = await commit('m2')
  git(root, 'switch', '-c', 'feature')
  const f1 = await commit('f1')
  git(root, 'switch', '-c', 'side')
  await commit('s1')
  git(root, 'switch', 'feature')
  git(root, 'merge', '--no-ff', '-m', 'merge side', 'side')
  const merge = git(root, 'rev-parse', 'HEAD')
  const f2 = await commit('f2')
  return { root, m1, m2, f1, merge, f2, host: new LocalHost() }
}

it('lists first-parent commits from the branch point to HEAD, oldest first', async () => {
  const r = await repository()
  const range = await listArchitectureCommits(
    r.host,
    { root: localPath(r.root) },
    signal(),
  )
  expect(range.base).toEqual({ revision: r.m2, parent: r.m1, subject: 'add m2' })
  expect(range.commits).toEqual([
    { revision: r.f1, parent: r.m2, subject: 'add f1' },
    { revision: r.merge, parent: r.f1, subject: 'merge side' },
    { revision: r.f2, parent: r.merge, subject: 'add f2' },
  ])
  expect(range.truncated).toBe(false)
})

it('widens the strip back to any ref', async () => {
  const r = await repository()
  const range = await listArchitectureCommits(
    r.host,
    {
      root: localPath(r.root),
      from: 'main~1',
    },
    signal(),
  )
  expect(range.base.revision).toBe(r.m1)
  expect(range.commits.map((commit) => commit.subject)).toEqual([
    'add m2',
    'add f1',
    'merge side',
    'add f2',
  ])
})

it('keeps the newest commits and says so when the range is over the limit', async () => {
  const r = await repository()
  const range = await listArchitectureCommits(
    r.host,
    { root: localPath(r.root) },
    signal(),
    2,
  )
  expect(range.commits.map((commit) => commit.revision)).toEqual([r.merge, r.f2])
  expect(range.truncated).toBe(true)
})

it('shows an empty strip on the default branch itself', async () => {
  const r = await repository()
  git(r.root, 'switch', 'main')
  const range = await listArchitectureCommits(
    r.host,
    { root: localPath(r.root) },
    signal(),
  )
  expect(range.base.revision).toBe(r.m2)
  expect(range.commits).toEqual([])
})

it('refuses option-shaped refs, unknown refs and foreign hosts', async () => {
  const r = await repository()
  const exec = vi.spyOn(r.host, 'exec')
  await expect(
    listArchitectureCommits(r.host, { root: localPath(r.root), from: '--all' }, signal()),
  ).rejects.toThrow(/ref/)
  await expect(
    listArchitectureCommits(
      r.host,
      { root: hostPath(asHostId('ssh'), r.root) },
      signal(),
    ),
  ).rejects.toThrow(/workspace/)
  expect(exec).not.toHaveBeenCalled()
  await expect(
    listArchitectureCommits(r.host, { root: localPath(r.root), from: 'nope' }, signal()),
  ).rejects.toThrow(/nope/)
})
