import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArchitectureCommitClassifier } from '../src/main/architecture-review/commit-classifier'
import { readModuleImports } from '../src/main/architecture-review/module-imports'
import { TYPESCRIPT_ONLY_SCANNERS } from '../src/main/architecture-review/typescript-scanner'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'

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
  const root = await mkdtemp(join(tmpdir(), 'hvir-commit-classifier-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
    git(root, 'add', '-A')
    git(root, 'commit', '--allow-empty', '-m', message)
    return git(root, 'rev-parse', 'HEAD')
  }
  return { root, commit, host: new LocalHost() }
}
function classifier() {
  const imports = vi.fn((sources, root, _signal) =>
    readModuleImports(sources, root, undefined, TYPESCRIPT_ONLY_SCANNERS),
  )
  return { imports, classifier: new ArchitectureCommitClassifier({ imports }) }
}

it('classifies each commit against its first parent and caches the answers', async () => {
  const r = await repository()
  const added = await r.commit('add modules', {
    'src/a.ts': "import { b } from './b'\nexport const a = b\n",
    'src/b.ts': 'export const b = 1\n',
  })
  const bodyOnly = await r.commit('edit body', {
    'src/b.ts': 'export const b = 2\n',
  })
  const rewired = await r.commit('rewire', {
    'src/a.ts': "import { c } from './c'\nexport const a = c\n",
    'src/c.ts': 'export const c = 3\n',
  })
  const docs = await r.commit('docs', { 'README.md': 'hello\n' })
  const empty = await r.commit('empty', {})
  git(r.root, 'switch', '-c', 'side')
  const side = await r.commit('side', { 'src/d.ts': 'export const d = 4\n' })
  git(r.root, 'switch', 'main')
  const mainOnly = await r.commit('main body', { 'src/b.ts': 'export const b = 5\n' })
  git(r.root, 'merge', '--no-ff', '-m', 'merge side', 'side')
  const merge = git(r.root, 'rev-parse', 'HEAD')
  const { imports, classifier: subject } = classifier()
  const request = {
    root: localPath(r.root),
    revisions: [merge, mainOnly, side, empty, docs, rewired, bodyOnly, added],
  }
  const result = await subject.classify(r.host, request, signal())
  expect(result.map((entry) => [entry.revision, entry.merge, entry.change])).toEqual([
    [merge, true, 'architecture'],
    [mainOnly, false, 'code'],
    [side, false, 'architecture'],
    [empty, false, 'none'],
    [docs, false, 'none'],
    [rewired, false, 'architecture'],
    [bodyOnly, false, 'code'],
    [added, false, 'architecture'],
  ])
  expect(result[0]?.parent).toBe(mainOnly)
  expect(result[7]?.parent).toBeNull()
  expect(imports).toHaveBeenCalledTimes(1)
  const again = await subject.classify(r.host, request, signal())
  expect(again).toEqual(result)
  expect(imports).toHaveBeenCalledTimes(1)
})

it('reads modules only inside the layout scope at HEAD', async () => {
  const r = await repository()
  await r.commit('layout', {
    '.hvir/architecture.json': '{"version":1,"scope":["src/app"]}\n',
  })
  const outside = await r.commit('outside', { 'src/lib/x.ts': 'export const x = 1\n' })
  const inside = await r.commit('inside', { 'src/app/y.ts': 'export const y = 1\n' })
  const { imports, classifier: subject } = classifier()
  const result = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [outside, inside] },
    signal(),
  )
  expect(result.map((entry) => entry.change)).toEqual(['none', 'architecture'])
  expect(imports).not.toHaveBeenCalled()
})

it('refuses malformed revisions, oversize requests and unknown commits', async () => {
  const r = await repository()
  const head = await r.commit('one', { 'src/a.ts': 'export {}\n' })
  const { classifier: subject } = classifier()
  const root = localPath(r.root)
  await expect(
    subject.classify(r.host, { root, revisions: ['HEAD'] }, signal()),
  ).rejects.toThrow(/revision/)
  await expect(
    subject.classify(r.host, { root, revisions: Array(51).fill(head) }, signal()),
  ).rejects.toThrow(/at most 50/)
  await expect(
    subject.classify(r.host, { root, revisions: ['f'.repeat(40)] }, signal()),
  ).rejects.toThrow()
  await expect(
    subject.classify(r.host, { root, revisions: [] }, signal()),
  ).resolves.toEqual([])
})

it('leaves a commit whose modules exceed the read budget unclassified', async () => {
  const r = await repository()
  await r.commit('big', { 'src/big.ts': 'export const big = 1\n' })
  const big = await r.commit('grow', {
    'src/big.ts': `export const big = "${'x'.repeat(600 * 1024)}"\n`,
  })
  const { imports, classifier: subject } = classifier()
  const result = await subject.classify(
    r.host,
    { root: localPath(r.root), revisions: [big] },
    signal(),
  )
  expect(result[0]?.change).toBe('unclassified')
  expect(imports).not.toHaveBeenCalled()
})
