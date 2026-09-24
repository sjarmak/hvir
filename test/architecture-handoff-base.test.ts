import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readArchitectureLiveBase } from '../src/main/architecture-review/freshness'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'

const roots: string[] = []
const hosts: LocalHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-base-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'README.md'), 'readme\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  const host = new LocalHost()
  hosts.push(host)
  return { root, host }
}
const read = (host: LocalHost, root: string) =>
  readArchitectureLiveBase(host, localPath(root), AbortSignal.timeout(10_000))

it('names HEAD and a clean in-scope tree, ignoring out-of-scope edits', async () => {
  const { root, host } = await repository()
  await writeFile(join(root, 'README.md'), 'edited\n')
  expect(await read(host, root)).toEqual({
    head: git(root, 'rev-parse', 'HEAD'),
    prefix: '',
    clean: true,
  })
})

it('reports an in-scope edit or a new source as not clean', async () => {
  const { root, host } = await repository()
  await writeFile(join(root, 'src/b.ts'), 'export const b = 1\n')
  expect((await read(host, root)).clean).toBe(false)
  await rm(join(root, 'src/b.ts'))
  await writeFile(join(root, 'src/a.ts'), 'export const a = 2\n')
  expect((await read(host, root)).clean).toBe(false)
})

it('discloses a workspace below the repository root by its prefix', async () => {
  const { root, host } = await repository()
  expect((await read(host, join(root, 'src'))).prefix).toBe('src/')
})
