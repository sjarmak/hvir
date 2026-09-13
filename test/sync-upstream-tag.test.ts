import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, 'scripts', 'sync-upstream-tag.sh')
const knownFailure = 'LocalHost > removes only the observed version of a file'

type RunResult = { status: number | null; stdout: string; stderr: string }

type Fixture = {
  root: string
  work: string
  upstreamBare: string
  forkBare: string
  callsLog: string
  env: NodeJS.ProcessEnv
  git: (dir: string, ...args: string[]) => string
  run: (args?: string[], extraEnv?: NodeJS.ProcessEnv) => RunResult
}

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
}

const npmStub = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$FIXTURE_CALLS_LOG"
exit 0
`

const npxStub = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$FIXTURE_CALLS_LOG"
case "\${STUB_VITEST_MODE:-pass}" in
  known)
    echo "     × removes only the observed version of a file 9ms"
    echo " FAIL  test/local-host.test.ts > ${knownFailure}"
    exit 1 ;;
  extra)
    echo "     × removes only the observed version of a file 9ms"
    echo "     × breaks 2ms"
    echo " FAIL  test/local-host.test.ts > ${knownFailure}"
    echo " FAIL  test/other.test.ts > other > breaks"
    exit 1 ;;
  prefix)
    echo " FAIL  test/local-host.test.ts > ${knownFailure} when the host reconnects"
    exit 1 ;;
  crash)
    echo "Error: failed to load config"
    exit 1 ;;
  *)
    echo " Tests  900 passed"
    exit 0 ;;
esac
`

async function createFixture({ conflict }: { conflict: boolean }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-sync-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  const env = makeGitEnv(home)

  const git = (dir: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
    return result.stdout
  }

  const upstream = join(root, 'upstream')
  await mkdir(join(upstream, 'src', 'main'), { recursive: true })
  git(upstream, 'init', '-q', '-b', 'main')
  await writeFile(join(upstream, 'README.md'), 'line one\nline two\nline three\n')
  await writeFile(join(upstream, 'src', 'main', 'ipc.ts'), 'registerA()\nregisterB()\n')
  await writeFile(join(upstream, 'package.json'), '{ "name": "fixture" }\n')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'base')
  git(upstream, 'tag', 'v0.1.0')
  if (conflict) {
    await writeFile(join(upstream, 'README.md'), 'line one\nupstream two\nline three\n')
    await writeFile(
      join(upstream, 'src', 'main', 'ipc.ts'),
      'registerA()\nregisterBUpstream()\n',
    )
  } else {
    await writeFile(
      join(upstream, 'src', 'main', 'ipc.ts'),
      'registerAUpstream()\nregisterB()\n',
    )
  }
  git(upstream, 'commit', '-q', '-am', 'release')
  git(upstream, 'tag', 'v0.2.0')

  const upstreamBare = join(root, 'upstream.git')
  const forkBare = join(root, 'fork.git')
  git(root, 'clone', '-q', '--bare', upstream, upstreamBare)
  git(root, 'clone', '-q', '--bare', upstreamBare, forkBare)

  const work = join(root, 'work')
  git(root, 'clone', '-q', upstreamBare, work)
  git(work, 'remote', 'add', 'fork', forkBare)
  git(work, 'switch', '-q', '-c', 'feat/beads-panel', 'v0.1.0')
  if (conflict) {
    await writeFile(join(work, 'README.md'), 'line one\noverlay two\nline three\n')
    await writeFile(
      join(work, 'src', 'main', 'ipc.ts'),
      'registerA()\nregisterBeadsIpc(router, deps)\n',
    )
  } else {
    await writeFile(
      join(work, 'src', 'main', 'ipc.ts'),
      'registerA()\nregisterB()\nregisterBeadsIpc(router, deps)\n',
    )
  }
  git(work, 'commit', '-q', '-am', 'overlay')
  git(work, 'tag', '-d', 'v0.2.0')
  git(work, 'config', 'rerere.enabled', 'false')

  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'npm'), npmStub)
  await writeFile(join(bin, 'npx'), npxStub)
  await chmod(join(bin, 'npm'), 0o755)
  await chmod(join(bin, 'npx'), 0o755)
  const callsLog = join(root, 'calls.log')

  const run = (args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): RunResult => {
    const result = spawnSync('bash', [scriptPath, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...env,
        HVIR_SYNC_NPM: join(bin, 'npm'),
        HVIR_SYNC_NPX: join(bin, 'npx'),
        FIXTURE_CALLS_LOG: callsLog,
        ...extraEnv,
      },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  return { root, work, upstreamBare, forkBare, callsLog, env, git, run }
}

function scratchBranches(fixture: Fixture): string[] {
  return fixture
    .git(fixture.work, 'branch', '--list', 'sync/*')
    .split('\n')
    .map((line) => line.replace(/^[* ]+/, '').trim())
    .filter((line) => line.length > 0)
}

describe('sync-upstream-tag.sh', () => {
  it('refuses a dirty tree but ignores untracked files', async () => {
    const fixture = await createFixture({ conflict: false })
    await writeFile(join(fixture.work, 'README.md'), 'edited\n')
    const dirty = fixture.run()
    expect(dirty.status).toBe(2)
    expect(dirty.stderr).toMatch(/uncommitted|dirty/i)
    expect(scratchBranches(fixture)).toEqual([])

    fixture.git(fixture.work, 'checkout', '--', 'README.md')
    await writeFile(join(fixture.work, 'notes.txt'), 'untracked\n')
    const untracked = fixture.run()
    expect(untracked.status).toBe(0)
    expect(scratchBranches(fixture)).toHaveLength(1)
  })

  it('refuses when rerere.enabled is not explicitly false', async () => {
    const fixture = await createFixture({ conflict: false })
    fixture.git(fixture.work, 'config', '--unset', 'rerere.enabled')
    const unset = fixture.run()
    expect(unset.status).toBe(2)
    expect(unset.stderr).toContain('git config rerere.enabled false')

    fixture.git(fixture.work, 'config', 'rerere.enabled', 'true')
    const enabled = fixture.run()
    expect(enabled.status).toBe(2)
    expect(enabled.stderr).toContain('git config rerere.enabled false')
    expect(scratchBranches(fixture)).toEqual([])
  })

  it('merges the newest tag on a scratch branch and runs the gates', async () => {
    const fixture = await createFixture({ conflict: false })
    const refsBefore = {
      upstream: fixture.git(fixture.upstreamBare, 'for-each-ref'),
      fork: fixture.git(fixture.forkBare, 'for-each-ref'),
      overlay: fixture.git(fixture.work, 'rev-parse', 'feat/beads-panel'),
    }

    const result = fixture.run([], { STUB_VITEST_MODE: 'known' })
    expect(result.status).toBe(0)

    const branches = scratchBranches(fixture)
    expect(branches).toHaveLength(1)
    expect(branches[0]).toMatch(/^sync\/v0\.2\.0-/)
    const parents = fixture.git(fixture.work, 'rev-list', '--parents', '-n1', 'HEAD')
    expect(parents.trim().split(' ')).toHaveLength(3)

    for (const gate of [
      'ci',
      'typecheck',
      'lint',
      'check-seams',
      'check-adrs',
      'vitest',
    ]) {
      expect(result.stdout).toContain(`${gate}: PASS`)
    }
    expect(result.stdout).toContain('Known pre-existing failure')
    expect(result.stdout).toContain(knownFailure)

    const calls = (await readFile(fixture.callsLog, 'utf8')).trim().split('\n')
    expect(calls).toEqual([
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm run check-seams',
      'npm run check-adrs',
      'npx vitest run',
    ])

    expect(fixture.git(fixture.upstreamBare, 'for-each-ref')).toBe(refsBefore.upstream)
    expect(fixture.git(fixture.forkBare, 'for-each-ref')).toBe(refsBefore.fork)
    expect(fixture.git(fixture.work, 'rev-parse', 'feat/beads-panel')).toBe(
      refsBefore.overlay,
    )
  })

  it('reports unexpected test failures and exits non-zero', async () => {
    const fixture = await createFixture({ conflict: false })
    const result = fixture.run([], { STUB_VITEST_MODE: 'extra' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('vitest: FAIL')
    expect(result.stdout).toContain('Unexpected test failures:')
    expect(result.stdout).toContain('other > breaks')
    expect(result.stdout).toContain('Known pre-existing failure')
  })

  it('treats a longer test name that starts with the known one as unexpected', async () => {
    const fixture = await createFixture({ conflict: false })
    const result = fixture.run([], { STUB_VITEST_MODE: 'prefix' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('vitest: FAIL')
    expect(result.stdout).toContain('Unexpected test failures:')
    expect(result.stdout).not.toContain('Known pre-existing failure')
  })

  it('fails closed when vitest exits non-zero with no FAIL lines', async () => {
    const fixture = await createFixture({ conflict: false })
    const result = fixture.run([], { STUB_VITEST_MODE: 'crash' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('vitest: FAIL')
    expect(result.stdout).toContain('no parsed failures')
    expect(result.stdout).not.toContain('Known pre-existing failure')
  })

  it('accepts an explicit tag', async () => {
    const fixture = await createFixture({ conflict: false })
    const merged = fixture.run(['v0.1.0'])
    expect(merged.status).toBe(0)
    expect(merged.stdout).toContain('already merged')
    expect(scratchBranches(fixture)).toEqual([])

    const synced = fixture.run(['v0.2.0'])
    expect(synced.status).toBe(0)
    expect(scratchBranches(fixture)[0]).toContain('v0.2.0')

    const unknown = fixture.run(['v9.9.9'])
    expect(unknown.status).toBe(2)

    const peeled = fixture.run(['v0.2.0^{}'])
    expect(peeled.status).toBe(2)
    expect(peeled.stderr).toContain('not a valid tag name')
    expect(scratchBranches(fixture)).toHaveLength(1)
  })

  it('ignores local and fork-only v* tags when picking the newest release', async () => {
    const fixture = await createFixture({ conflict: false })
    fixture.git(fixture.work, 'tag', 'v9.9.9-local', 'feat/beads-panel')
    fixture.git(fixture.work, 'push', '-q', 'fork', 'refs/tags/v9.9.9-local:refs/tags/v9.9.8-fork')
    fixture.git(fixture.work, 'tag', '-d', 'v9.9.9-local')
    const withLocal = fixture.run([])
    expect(withLocal.status).toBe(0)
    expect(withLocal.stdout).not.toContain('already merged')
    expect(scratchBranches(fixture)).toHaveLength(1)
    expect(scratchBranches(fixture)[0]).toMatch(/^sync\/v0\.2\.0-/)
    expect(fixture.git(fixture.work, 'tag', '--list', 'v9.9.8-fork').trim()).toBe('v9.9.8-fork')
  })

  it('refuses before branching when an untracked file would be overwritten', async () => {
    const fixture = await createFixture({ conflict: false })
    await writeFile(join(fixture.work, 'src', 'main', 'ipc.ts.orig'), 'scratch\n')
    await mkdir(join(fixture.work, 'docs'))
    await writeFile(join(fixture.work, 'docs', 'new.md'), 'local draft\n')
    const upstream = join(fixture.root, 'upstream')
    await mkdir(join(upstream, 'docs'))
    await writeFile(join(upstream, 'docs', 'new.md'), 'upstream doc\n')
    fixture.git(upstream, 'add', 'docs/new.md')
    fixture.git(upstream, 'commit', '-q', '-m', 'add doc')
    fixture.git(upstream, 'tag', 'v0.3.0')
    fixture.git(upstream, 'push', '-q', fixture.upstreamBare, 'main', 'refs/tags/v0.3.0')

    const result = fixture.run()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('untracked files would be overwritten')
    expect(result.stderr).toContain('docs/new.md')
    expect(result.stderr).not.toContain('ipc.ts.orig')
    expect(scratchBranches(fixture)).toEqual([])
    expect(fixture.git(fixture.work, 'branch', '--show-current').trim()).toBe('feat/beads-panel')
  })

  it('stops on conflicts and groups wiring files', async () => {
    const fixture = await createFixture({ conflict: true })
    const refsBefore = {
      upstream: fixture.git(fixture.upstreamBare, 'for-each-ref'),
      fork: fixture.git(fixture.forkBare, 'for-each-ref'),
    }
    const result = fixture.run()
    expect(result.status).toBe(1)
    expect(fixture.git(fixture.upstreamBare, 'for-each-ref')).toBe(refsBefore.upstream)
    expect(fixture.git(fixture.forkBare, 'for-each-ref')).toBe(refsBefore.fork)

    const wiringIndex = result.stdout.indexOf('Overlay wiring files')
    const otherIndex = result.stdout.indexOf('Other conflicted files')
    expect(wiringIndex).toBeGreaterThanOrEqual(0)
    expect(otherIndex).toBeGreaterThan(wiringIndex)
    const wiringSection = result.stdout.slice(wiringIndex, otherIndex)
    const otherSection = result.stdout.slice(otherIndex)
    expect(wiringSection).toContain('src/main/ipc.ts')
    expect(wiringSection).not.toContain('README.md')
    expect(otherSection).toContain('README.md')
    expect(otherSection).not.toContain('src/main/ipc.ts')

    const unmerged = fixture.git(fixture.work, 'diff', '--name-only', '--diff-filter=U')
    expect(unmerged.trim().split('\n').sort()).toEqual(['README.md', 'src/main/ipc.ts'])
    expect(existsSync(fixture.callsLog)).toBe(false)
  })

  it('the old push-and-rerere script is gone', () => {
    expect(existsSync(join(repoRoot, 'scripts', 'sync-upstream.sh'))).toBe(false)
  })
})
