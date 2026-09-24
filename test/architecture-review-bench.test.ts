import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  medianOf,
  parseBenchArguments,
  runArchitectureReviewBench,
} from '../scripts/architecture-review-bench-run.mts'

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
  })
  expect(parseBenchArguments(['/repo', 'branch-point'])).toMatchObject({ runs: 1 })
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
  const report = await runArchitectureReviewBench({ root, mode: 'working-tree', runs: 2 })
  expect(report).toMatchObject({ root, mode: 'working-tree', runs: 2 })
  expect(report.samples).toHaveLength(2)
  expect(report.files).toEqual({ baseline: 2, current: 2 })
  expect(report.median.stages.map((stage) => stage.stage)).toEqual([
    'listing',
    'blob-read',
    'live-read',
    'live-recheck',
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
})
