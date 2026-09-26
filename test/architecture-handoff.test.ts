import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ArchitectureLaunches,
  handoffCommit,
  readArchitectureBriefOrigin,
  writeArchitectureBrief,
} from '../src/main/architecture-review/handoff'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared/host-path'

const cleanups: string[] = []
const HEAD = 'b'.repeat(40)
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function repositoryWithWorktree(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-handoff-'))
  const worktree = `${root}.hvir-worktrees/review-1`
  cleanups.push(root, `${root}.hvir-worktrees`)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'hvir@example.test')
  git(root, 'config', 'user.name', 'hvir')
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', 'a.ts')
  git(root, 'commit', '-q', '-m', 'initial')
  git(root, 'worktree', 'add', '-q', '-b', 'hvir/architecture/review-1', worktree)
  return { root, worktree }
}

it('writes the brief untracked, excluded through info/exclude and never .gitignore', async () => {
  const { root, worktree } = await repositoryWithWorktree()
  const host = new LocalHost()
  const brief = '<!-- hvir-architecture-handoff {} -->\n# brief\n'
  await writeArchitectureBrief(
    host,
    localPath(worktree),
    brief,
    AbortSignal.timeout(10_000),
  )
  expect(await readFile(join(worktree, '.hvir-architecture-brief.md'), 'utf8')).toBe(
    brief,
  )
  expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  expect(git(worktree, 'check-ignore', '.hvir-architecture-brief.md')).toBe(
    '.hvir-architecture-brief.md',
  )
  const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')
  expect(
    exclude.split('\n').filter((line) => line === '/.hvir-architecture-brief.md'),
  ).toHaveLength(1)
  await expect(readFile(join(worktree, '.gitignore'), 'utf8')).rejects.toThrow(/ENOENT/)
  // The person's own tree shows nothing either: the exclude names only the root file.
  expect(git(root, 'status', '--porcelain')).toBe('')
})

it('adds the exclude line once and never overwrites an existing brief', async () => {
  const { root, worktree } = await repositoryWithWorktree()
  const host = new LocalHost()
  const signal = AbortSignal.timeout(10_000)
  await mkdir(join(root, '.git', 'info'), { recursive: true })
  await writeFile(join(root, '.git', 'info', 'exclude'), '*.log')
  await writeArchitectureBrief(host, localPath(worktree), 'one', signal)
  await expect(
    writeArchitectureBrief(host, localPath(worktree), 'two', signal),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(
    '*.log\n/.hvir-architecture-brief.md\n/.hvir-architecture-explanation.json\n',
  )
  expect(await readFile(join(worktree, '.hvir-architecture-brief.md'), 'utf8')).toBe(
    'one',
  )
})

it('reads a worktree origin from the brief marker, null when absent or forged', async () => {
  const { worktree } = await repositoryWithWorktree()
  const host = new LocalHost()
  const file = localPath(join(worktree, '.hvir-architecture-brief.md'))
  expect(await readArchitectureBriefOrigin(host, file)).toBeNull()
  const origin = {
    version: 1,
    baselineRef: 'main',
    baselineRevision: 'a'.repeat(40),
    currentRef: 'working tree',
    currentRevision: HEAD,
  }
  await writeFile(
    file.path,
    `<!-- hvir-architecture-handoff ${JSON.stringify(origin)} -->\n`,
  )
  expect(await readArchitectureBriefOrigin(host, file)).toMatchObject({
    currentRevision: HEAD,
  })
  await writeFile(file.path, `<!-- hvir-architecture-handoff {"version":1} -->\n`)
  expect(await readArchitectureBriefOrigin(host, file)).toBeNull()
})

it('starts at the Current commit, or the clean HEAD a live Current equals', () => {
  expect(handoffCommit('c'.repeat(40), { head: HEAD, prefix: '', clean: false })).toBe(
    'c'.repeat(40),
  )
  expect(handoffCommit(undefined, { head: HEAD, prefix: '', clean: true })).toBe(HEAD)
  expect(() =>
    handoffCommit(undefined, { head: HEAD, prefix: '', clean: false }),
  ).toThrow(/Commit the in-scope changes/)
  expect(() => handoffCommit(HEAD, { head: HEAD, prefix: 'src/', clean: true })).toThrow(
    /repository root/,
  )
})

it('issues single-use launches bound to renderer, host, worktree and digest', () => {
  const launches = new ArchitectureLaunches()
  const owner = { id: 1, generation: 1 }
  const host = {} as ProjectHost
  const root = localPath('/repo.hvir-worktrees/review-1')
  const launch = launches.issue(owner, host, root, 'digest', 'prompt')
  for (const [who, on, forged] of [
    [{ id: 1, generation: 2 }, host, launch],
    [owner, {} as ProjectHost, launch],
    [owner, host, { ...launch, root: localPath('/repo') }],
    [owner, host, { ...launch, digest: 'other' }],
  ] as const)
    expect(() => launches.consume(who, on, forged)).toThrow(/unavailable/)
  expect(() => launches.assertCurrent(owner, host, launch)).toThrow(/cancelled/)
  expect(launches.consume(owner, host, launch)).toBe('prompt')
  launches.assertCurrent(owner, host, launch)
  expect(() => launches.consume(owner, host, launch)).toThrow(/already used/)
  for (let index = 0; index < 16; index++) launches.issue(owner, host, root, 'd', 'p')
  expect(() => launches.assertCurrent(owner, host, launch)).toThrow(/cancelled/)
})
