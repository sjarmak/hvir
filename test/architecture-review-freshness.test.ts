import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArchitectureReviewCoordinator } from '../src/main/architecture-review/coordinator'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { readArchitectureLiveState } from '../src/main/architecture-review/freshness'
import { LocalHost } from '../src/main/project-host/local-host'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { localPath } from '../src/shared/host-path'
import type { ArchitectureComparisonMode } from '../src/shared/architecture-review'
import type { ArchitectureAnalysis } from '../src/shared/architecture-analysis'

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
const emptyScan = {
  fingerprint: '',
  scope: 'test',
  exclusions: [],
  modules: [],
  imports: [],
  diagnostics: [],
}
const analysis: ArchitectureAnalysis = {
  before: emptyScan,
  after: emptyScan,
  modules: [],
  relationships: [],
  imports: [],
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-freshness-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'README.md'), 'readme\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  git(root, 'checkout', '-b', 'feature')
  await writeFile(join(root, 'src/b.ts'), "import { a } from './a'\nexport const b = a\n")
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'feature')
  return root
}

async function reviewOf(root: string, mode: ArchitectureComparisonMode) {
  const host = new LocalHost()
  hosts.push(host)
  const resources = new RendererResourceScopes()
  const owner = resources.activateOwner(1)
  const capture = vi.fn(captureArchitecture)
  const liveState = vi.fn(readArchitectureLiveState)
  const coordinator = new ArchitectureReviewCoordinator({
    resources,
    capture,
    liveState,
    analyze: () => Promise.resolve(analysis),
  })
  const request = { root: localPath(root), mode, reviewId: 'tab-1' }
  const snapshot = await coordinator.scan(owner, host, request)
  const evidenceRequest = {
    ...request,
    snapshotId: snapshot.id,
    path: localPath(join(root, 'src/a.ts')),
  }
  return {
    capture,
    liveState,
    stale: async () => (await coordinator.evidence(owner, host, evidenceRequest)).stale,
    prepare: () => coordinator.prepare(owner, host, evidenceRequest),
  }
}

it('never marks a commit-to-commit snapshot stale and never reads the host to decide', async () => {
  const root = await repository()
  const review = await reviewOf(root, 'branch-point')
  await appendFile(join(root, 'src/a.ts'), 'export const edited = 2\n')
  git(root, 'commit', '-am', 'moved on')
  expect(await review.stale()).toBe(false)
  expect((await review.prepare()).body).toContain('a.ts')
  expect(review.capture).toHaveBeenCalledTimes(1)
  expect(review.liveState).not.toHaveBeenCalled()
})

it('turns a live snapshot stale after an in-scope edit through the cheap check only', async () => {
  const root = await repository()
  const review = await reviewOf(root, 'head')
  expect(await review.stale()).toBe(false)
  await writeFile(join(root, 'README.md'), 'out of scope edit\n')
  expect(await review.stale()).toBe(false)
  await appendFile(join(root, 'src/a.ts'), 'export const edited = 2\n')
  expect(await review.stale()).toBe(true)
  await expect(review.prepare()).rejects.toThrow(/stale/)
  expect(review.capture).toHaveBeenCalledTimes(1)
})

it('notices a second edit to a file that was already modified at scan time', async () => {
  const root = await repository()
  await appendFile(join(root, 'src/a.ts'), 'export const first = 1\n')
  const review = await reviewOf(root, 'working-tree')
  expect(await review.stale()).toBe(false)
  await appendFile(join(root, 'src/a.ts'), 'export const second = 2\n')
  expect(await review.stale()).toBe(true)
  expect(review.capture).toHaveBeenCalledTimes(1)
})

it('notices new untracked sources, staging and a moved HEAD on a live snapshot', async () => {
  const root = await repository()
  const untracked = await reviewOf(root, 'head')
  await mkdir(join(root, 'src/new'))
  await writeFile(join(root, 'src/new/c.ts'), 'export const c = 3\n')
  expect(await untracked.stale()).toBe(true)

  const staged = await reviewOf(root, 'working-tree')
  git(root, 'add', 'src/new/c.ts')
  expect(await staged.stale()).toBe(true)

  const moved = await reviewOf(root, 'head')
  git(root, 'commit', '-m', 'c')
  expect(await moved.stale()).toBe(true)
})

it('reads the live state in one host call when the tree is clean', async () => {
  const root = await repository()
  const host = new LocalHost()
  hosts.push(host)
  const exec = vi.spyOn(host, 'exec')
  const clean = await readArchitectureLiveState(
    host,
    localPath(root),
    new AbortController().signal,
  )
  expect(exec).toHaveBeenCalledTimes(1)
  await appendFile(join(root, 'src/a.ts'), 'export const edited = 2\n')
  const dirty = await readArchitectureLiveState(
    host,
    localPath(root),
    new AbortController().signal,
  )
  expect(exec).toHaveBeenCalledTimes(3)
  expect(dirty).not.toBe(clean)
})

it('checks a workspace below the repository root against its own paths', async () => {
  const root = await repository()
  const host = new LocalHost()
  hosts.push(host)
  const read = () =>
    readArchitectureLiveState(
      host,
      localPath(join(root, 'src')),
      new AbortController().signal,
    )
  const before = await read()
  await writeFile(join(root, 'README.md'), 'outside the workspace\n')
  expect(await read()).toBe(before)
  await appendFile(join(root, 'src/a.ts'), 'export const edited = 2\n')
  expect(await read()).not.toBe(before)
})

async function conflicted(root: string) {
  git(root, 'checkout', '-b', 'theirs', 'main')
  await writeFile(join(root, 'src/a.ts'), 'export const a = "theirs"\n')
  git(root, 'commit', '-am', 'theirs')
  git(root, 'checkout', 'feature')
  await writeFile(join(root, 'src/a.ts'), 'export const a = "ours"\n')
  git(root, 'commit', '-am', 'ours')
  expect(() => git(root, 'merge', 'theirs')).toThrow()
  expect(git(root, 'status', '--porcelain', '--', 'src/a.ts')).toBe('UU src/a.ts')
}

it('notices an edit to a file with an unresolved merge conflict', async () => {
  const root = await repository()
  await conflicted(root)
  const review = await reviewOf(root, 'head')
  expect(await review.stale()).toBe(false)
  await appendFile(join(root, 'src/a.ts'), 'export const resolved = 2\n')
  expect(await review.stale()).toBe(true)
  expect(review.capture).toHaveBeenCalledTimes(1)
})

it('tolerates a conflicted file removed from the working tree', async () => {
  const root = await repository()
  await conflicted(root)
  const review = await reviewOf(root, 'head')
  await rm(join(root, 'src/a.ts'))
  expect(await review.stale()).toBe(true)
})

it('notices an edit to a file marked assume-unchanged', async () => {
  const root = await repository()
  git(root, 'update-index', '--assume-unchanged', 'src/a.ts')
  const review = await reviewOf(root, 'working-tree')
  expect(await review.stale()).toBe(false)
  await appendFile(join(root, 'src/a.ts'), 'export const hidden = 2\n')
  expect(git(root, 'status', '--porcelain')).toBe('')
  expect(await review.stale()).toBe(true)
})
