import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import {
  architectureRefProblem,
  type ArchitectureCaptureRequest,
} from '../src/shared/architecture-review'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
/** main: one; feature: two, three (tagged v3); live edit: four. */
async function history() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-ends-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await mkdir(join(root, 'src'))
  const commit = async (value: number) => {
    await writeFile(join(root, 'src/a.ts'), `export const value = ${value}\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-m', `value ${value}`)
    return git(root, 'rev-parse', 'HEAD')
  }
  const one = await commit(1)
  git(root, 'switch', '-c', 'feature')
  const two = await commit(2)
  const three = await commit(3)
  git(root, 'tag', 'v3')
  await writeFile(join(root, 'src/a.ts'), 'export const value = 4\n')
  const host = new LocalHost()
  const capture = (ends: Omit<ArchitectureCaptureRequest, 'root'>) =>
    captureArchitecture(
      host,
      { root: localPath(root), ...ends },
      new AbortController().signal,
    )
  return { root, host, one, two, three, capture }
}
const valueOf = (content: string | undefined) => /value = (\d)/.exec(content ?? '')?.[1]

it('defaults to the branch point against the live working tree', async () => {
  const f = await history()
  const snapshot = await f.capture({})
  expect(snapshot).toMatchObject({
    baselineRef: 'branch point',
    currentRef: 'working tree',
    baselineRevision: f.one,
    currentRevision: 'working-tree',
  })
  expect(valueOf(snapshot.before[0]?.content)).toBe('1')
  expect(valueOf(snapshot.after[0]?.content)).toBe('4')
})

it('accepts a branch, tag, HEAD~n or abbreviated hash for either end', async () => {
  const f = await history()
  const pair = await f.capture({ baseline: 'HEAD~1', current: 'v3' })
  expect(pair).toMatchObject({
    baselineRef: 'HEAD~1',
    currentRef: 'v3',
    baselineRevision: f.two,
    currentRevision: f.three,
  })
  expect([valueOf(pair.before[0]?.content), valueOf(pair.after[0]?.content)]).toEqual([
    '2',
    '3',
  ])
  const reversed = await f.capture({ baseline: 'feature', current: f.one.slice(0, 9) })
  expect([reversed.baselineRevision, reversed.currentRevision]).toEqual([f.three, f.one])
  const live = await f.capture({ baseline: 'main' })
  expect([valueOf(live.before[0]?.content), valueOf(live.after[0]?.content)]).toEqual([
    '1',
    '4',
  ])
})

it('takes the branch point of a Current commit, not of HEAD', async () => {
  const f = await history()
  git(f.root, 'switch', '-f', 'main')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 5\n')
  git(f.root, 'commit', '-am', 'main moved on')
  const snapshot = await f.capture({ current: 'feature' })
  expect([snapshot.baselineRevision, snapshot.currentRevision]).toEqual([f.one, f.three])
})

it('reads two commit ends from Git objects, looking in the working tree only for the scope', async () => {
  const f = await history()
  const exec = vi.spyOn(f.host, 'exec')
  await f.capture({ baseline: 'HEAD~1', current: 'HEAD' })
  const commands = exec.mock.calls.map(([command, args]) =>
    [command, ...args.filter((arg) => !arg.startsWith('/'))].join(' '),
  )
  expect(commands.filter((command) => command.includes('ls-files'))).toEqual([
    'git -C ls-files -z -t --cached --deleted --others --exclude-standard -- .hvir/architecture.json',
  ])
  expect(commands.some((command) => command.startsWith('sh '))).toBe(false)
})

it('refuses option-shaped and malformed refs before running Git', async () => {
  const f = await history()
  const exec = vi.spyOn(f.host, 'exec')
  for (const ends of [
    { baseline: '--output=/tmp/x' },
    { current: '-n1' },
    { baseline: '' },
    { current: 'HEAD ~1' },
    { baseline: 'a\nb' },
    { current: 7 as unknown as string },
  ])
    await expect(f.capture(ends)).rejects.toThrow(/ref/i)
  expect(exec).not.toHaveBeenCalled()
})

it('names an end that Git cannot resolve to a commit', async () => {
  const f = await history()
  await expect(f.capture({ baseline: 'no-such-branch' })).rejects.toThrow(
    /Baseline.*no-such-branch/,
  )
  await expect(f.capture({ current: 'HEAD:src' })).rejects.toThrow(/Current.*HEAD:src/)
})

it('explains why a ref is refused', () => {
  for (const ref of ['HEAD', 'HEAD~12', 'v1.0', 'origin/main', 'HEAD@{1}', 'a1b2c3d'])
    expect(architectureRefProblem(ref)).toBeUndefined()
  expect(architectureRefProblem('-x')).toMatch(/-/)
  expect(architectureRefProblem('')).toMatch(/Enter/)
  expect(architectureRefProblem('a'.repeat(300))).toMatch(/long/)
  expect(architectureRefProblem('a\tb')).toMatch(/spaces/)
  expect(architectureRefProblem(undefined)).toMatch(/Enter/)
})
