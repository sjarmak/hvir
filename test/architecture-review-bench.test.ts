import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  medianOf,
  parseBenchArguments,
  runArchitectureReviewBench,
} from '../scripts/architecture-review-bench-run.mts'
import { openArchitectureBenchHost } from '../scripts/architecture-review-bench-host.mts'
import { LocalHost } from '../src/main/project-host/local-host'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })

it('parses the root, mode and run count and refuses anything else', () => {
  expect(parseBenchArguments(['/repo', 'working-tree', '--runs', '3'])).toEqual({
    root: '/repo',
    mode: 'working-tree',
    runs: 3,
    host: 'local',
    cache: 'cold',
  })
  expect(parseBenchArguments(['/repo', 'branch-point'])).toMatchObject({
    runs: 1,
    host: 'local',
  })
  expect(
    parseBenchArguments(['/srv/repo', 'head', '--ssh', '--runs', '2', '--cache', 'warm']),
  ).toEqual({
    root: '/srv/repo',
    mode: 'head',
    runs: 2,
    host: 'ssh',
    cache: 'warm',
  })
  expect(() => parseBenchArguments(['/repo', 'head', '--cache', 'hot'])).toThrow(
    /cold or warm/,
  )
  expect(() => parseBenchArguments(['/repo', 'head', '--cache'])).toThrow(/cold or warm/)
  expect(() => parseBenchArguments(['/repo', 'head', '--ssh', '--ssh'])).toThrow(/Usage/)
  expect(() => parseBenchArguments(['/repo', 'head', '--remote'])).toThrow(/Usage/)
  expect(() => parseBenchArguments(['/repo', 'head', '--runs'])).toThrow(/runs/)
  expect(() => parseBenchArguments(['relative', 'head'])).toThrow(/absolute/)
  expect(() => parseBenchArguments(['/repo', 'commit'])).toThrow(/mode/)
  expect(() => parseBenchArguments(['/repo', 'head', '--runs', '0'])).toThrow(/runs/)
})

it('takes the median of an odd or even sample', () => {
  expect(medianOf([3, 1, 2])).toBe(2)
  expect(medianOf([4, 1, 2, 3])).toBe(2.5)
})

it('reports per-stage medians and every sample for a local repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-bench-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), "import './b'\n")
  await writeFile(join(root, 'src/b.ts'), 'export const b = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  const report = await runArchitectureReviewBench({
    root,
    mode: 'working-tree',
    runs: 2,
    host: 'local',
    cache: 'cold',
  })
  expect(report).toMatchObject({ root, mode: 'working-tree', runs: 2, target: 'local' })
  expect(report.samples).toHaveLength(2)
  expect(report.files).toEqual({ baseline: 2, current: 2 })
  expect(report.median.stages.map((stage) => stage.stage)).toEqual([
    'listing',
    'blob-read',
    'live-read',
    'hashing',
    'parse',
    'compare',
    'renderer-payload',
  ])
  for (const stage of report.median.stages) {
    expect(stage.durationMs).toBeGreaterThanOrEqual(0)
    expect(stage.bytes).toBeGreaterThanOrEqual(0)
  }
  expect(report.median.totalMs).toBeGreaterThan(0)
  expect(report.samples.map((sample) => sample.cache)).toEqual([
    { hits: 0, misses: 2, discarded: 0 },
    { hits: 0, misses: 2, discarded: 0 },
  ])
})

it('fills the cache once and answers every warm sample from it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-bench-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await writeFile(join(root, 'a.ts'), "import './b'\n")
  await writeFile(join(root, 'b.ts'), 'export const b = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  const report = await runArchitectureReviewBench({
    root,
    mode: 'head',
    runs: 2,
    host: 'local',
    cache: 'warm',
  })
  expect(report.samples.map((sample) => sample.cache)).toEqual([
    { hits: 2, misses: 0, discarded: 0 },
    { hits: 2, misses: 0, discarded: 0 },
  ])
  expect(report.note).toMatch(/warm parse cache/)
})

it('scans through the host the opener returns and names its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-bench-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  const opened: string[] = []
  const report = await runArchitectureReviewBench(
    { root, mode: 'head', runs: 1, host: 'ssh', cache: 'cold' },
    (kind) => {
      opened.push(kind)
      const host = new LocalHost()
      return Promise.resolve({
        host,
        target: 'bench.example.test',
        dispose: () => host.dispose(),
      })
    },
  )
  expect(opened).toEqual(['ssh'])
  expect(report).toMatchObject({ host: 'ssh', target: 'bench.example.test' })
  expect(report.files).toEqual({ baseline: 1, current: 1 })
})

it('refuses an SSH bench without an explicit pinned target', async () => {
  await expect(openArchitectureBenchHost('ssh', {})).rejects.toThrow(
    /HVIR_REAL_SSH_HOST.*HVIR_REAL_SSH_HOST_KEY/s,
  )
  await expect(
    openArchitectureBenchHost('ssh', { HVIR_REAL_SSH_HOST: 'bench.example.test' }),
  ).rejects.toThrow(/HVIR_REAL_SSH_PORT/)
})

it('opens the local host for a local bench', async () => {
  const opened = await openArchitectureBenchHost('local', {})
  try {
    expect(opened.host.hostId).toBe('local')
    expect(opened.target).toBe('local')
  } finally {
    await opened.dispose()
  }
})

const repository = join(import.meta.dirname, '..')
const launch = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/architecture-review-bench.mts', ...args], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 120_000,
  })

it('runs from the documented node command and reports a local scan as JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-bench-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  const result = launch(root, 'head', '--runs', '2')
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const report = JSON.parse(result.stdout) as Record<string, unknown>
  expect(report).toMatchObject({ root, mode: 'head', runs: 2, target: 'local' })
  expect(report.samples).toHaveLength(2)
  const refused = launch('relative', 'head')
  expect(refused.status).toBe(1)
  expect(refused.stderr).toMatch(/absolute/)
}, 120_000)
