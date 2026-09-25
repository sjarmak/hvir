import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { hvirWorktreeTarget } from '../src/main/git/hvir-worktrees'
import { inspectUnfinishedHandoff } from '../src/main/architecture-review/unfinished-handoff'
import { LocalHost } from '../src/main/project-host'
import { ARCHITECTURE_BRIEF_FILE, localPath } from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('unfinished handoff detection', () => {
  it('recognises a handoff worktree with no brief, no session, no commits and no changes', async () => {
    const fixture = await handoffFixture()

    await expect(fixture.inspect()).resolves.toEqual({
      unfinished: true,
      target: fixture.target,
    })
  })

  it('does not mark a worktree whose brief landed', async () => {
    const fixture = await handoffFixture()
    await writeFile(join(fixture.target.path, ARCHITECTURE_BRIEF_FILE), 'brief\n')

    await expectRefused(fixture.inspect(), 'brief')
  })

  it('does not mark a worktree that has an hvir terminal session', async () => {
    const fixture = await handoffFixture()

    await expectRefused(fixture.inspect({ terminalIds: ['terminal-1'] }), 'terminal')
  })

  it('does not mark a branch with commits beyond its start point', async () => {
    const fixture = await handoffFixture()
    git(fixture.target.path, ['commit', '--allow-empty', '-m', 'agent work'])

    await expectRefused(fixture.inspect({ head: headOf(fixture.target.path) }), 'commits')
  })

  it('does not mark a branch that was moved and moved back', async () => {
    const fixture = await handoffFixture()
    git(fixture.target.path, ['commit', '--allow-empty', '-m', 'agent work'])
    git(fixture.target.path, ['reset', '--hard', fixture.target.commit])

    await expect(fixture.inspect()).resolves.toMatchObject({ unfinished: false })
  })

  it.each([
    ['a modified tracked file', 'tracked.txt'],
    ['an untracked file', 'new.txt'],
  ])('does not mark a worktree with %s', async (_label, file) => {
    const fixture = await handoffFixture()
    await writeFile(join(fixture.target.path, file), 'changed\n')

    await expectRefused(fixture.inspect(), 'changes')
  })

  it('does not mark a worktree holding ignored files that removal would delete', async () => {
    const fixture = await handoffFixture()
    await writeFile(join(fixture.target.path, 'build.log'), 'ignored\n')

    await expectRefused(fixture.inspect(), 'changes')
  })

  it('does not mark a branch outside hvir/architecture/', async () => {
    const fixture = await handoffFixture()

    await expectRefused(
      fixture.inspect({ branch: 'feature/review-1' }),
      'hvir/architecture/',
    )
  })

  it('does not mark the main working tree or a path outside the owned location', async () => {
    const fixture = await handoffFixture()

    await expect(fixture.inspect({ root: fixture.rootPath })).resolves.toMatchObject({
      unfinished: false,
    })
    await expect(
      fixture.inspect({ root: `${fixture.rootPath}.hvir-worktrees/../escape` }),
    ).resolves.toMatchObject({ unfinished: false })
  })

  it('does not mark an owned location that resolves elsewhere through a symlink', async () => {
    const fixture = await handoffFixture()
    const link = `${fixture.rootPath}.hvir-worktrees/review-2`
    await symlink(fixture.target.path, link)

    await expectRefused(
      fixture.inspect({ root: link, branch: 'hvir/architecture/review-2' }),
      'resolves',
    )
  })
})

async function handoffFixture() {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), 'hvir-unfinished-')))
  cleanups.push(rootPath, `${rootPath}.hvir-worktrees`)
  git(rootPath, ['init', '-b', 'main'])
  git(rootPath, ['config', 'user.email', 'hvir@example.test'])
  git(rootPath, ['config', 'user.name', 'hvir test'])
  await writeFile(join(rootPath, 'tracked.txt'), 'base\n')
  await writeFile(join(rootPath, '.gitignore'), '*.log\n')
  git(rootPath, ['add', '.'])
  git(rootPath, ['commit', '-m', 'base'])
  const root = localPath(rootPath)
  const target = hvirWorktreeTarget(root, 'review-1', headOf(rootPath))
  await mkdir(`${rootPath}.hvir-worktrees`, { recursive: true })
  git(rootPath, ['worktree', 'add', '-b', target.branch, target.path, target.commit])
  const host = new LocalHost()
  return {
    rootPath,
    target,
    inspect: (
      overrides: {
        readonly root?: string
        readonly branch?: string
        readonly head?: string
        readonly terminalIds?: readonly string[]
      } = {},
    ) =>
      inspectUnfinishedHandoff(
        host,
        root,
        {
          root: localPath(overrides.root ?? target.path),
          branch: overrides.branch ?? target.branch,
          head: overrides.head ?? target.commit,
        },
        overrides.terminalIds ?? [],
      ),
  }
}

function headOf(path: string): string {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

async function expectRefused(
  inspection: ReturnType<typeof inspectUnfinishedHandoff>,
  fragment: string,
): Promise<void> {
  const verdict = await inspection
  expect(verdict.unfinished).toBe(false)
  if (!verdict.unfinished) expect(verdict.reason).toContain(fragment)
}
