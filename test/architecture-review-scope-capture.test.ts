import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import { ARCHITECTURE_SCOPE } from '../src/shared/architecture-review'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import { ArchitectureScopeRefusalError } from '../src/main/architecture-review/scope-cap'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

/** `count` sources spread over `directories`, committed as the baseline. */
async function fixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-scope-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await write(root, files)
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  return root
}
async function write(root: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
}
function sources(count: number, directory = (index: number) => `d${index % 4}`) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `src/${directory(index)}/m${index}.ts`,
      `export const m${index} = ${index}\n`,
    ]),
  )
}
async function capture(
  root: string,
  ends: { baseline?: string; current?: string } = { baseline: 'HEAD' },
  recorder = new ArchitectureScanRecorder(),
) {
  return captureArchitecture(
    new LocalHost(),
    { root: localPath(root), ...ends },
    new AbortController().signal,
    recorder,
  )
}
async function refusalOf(pending: Promise<unknown>) {
  const error: unknown = await pending.then(
    () => new Error('expected a refusal'),
    (reason: unknown) => reason,
  )
  if (!(error instanceof ArchitectureScopeRefusalError)) throw error
  return error.refusal
}

it('reads every file at the cap and never truncates', async () => {
  const root = await fixture(sources(ARCHITECTURE_SCOPE.maxFiles))
  const result = await capture(root)
  expect(result.after).toHaveLength(ARCHITECTURE_SCOPE.maxFiles)
  expect(result.before).toHaveLength(ARCHITECTURE_SCOPE.maxFiles)
}, 60_000)

it('refuses one file over the cap before reading any source, naming the counts', async () => {
  const root = await fixture(sources(ARCHITECTURE_SCOPE.maxFiles + 1))
  const recorder = new ArchitectureScanRecorder()
  const refusal = await refusalOf(capture(root, { baseline: 'HEAD' }, recorder))
  expect(refusal.files).toBe(4_001)
  expect(refusal.end).toBe('working tree')
  expect(refusal.message).toContain('working tree has 4,001 files')
  expect(refusal.message).toContain('Choose a narrower scope')
  expect(refusal.candidates.map((candidate) => candidate.path)).toEqual(['src'])
  const stages = recorder.metrics().spans.map((span) => span.stage)
  expect(stages).not.toContain('live-read')
  expect(stages).not.toContain('blob-read')
}, 60_000)

it('scans an over-cap repository once the layout file narrows its scope', async () => {
  const root = await fixture({
    ...sources(ARCHITECTURE_SCOPE.maxFiles + 1, (index) =>
      index < 10 ? 'kept' : 'rest',
    ),
  })
  await write(root, {
    '.hvir/architecture.json': JSON.stringify({ version: 1, scope: ['src/kept'] }),
  })
  const result = await capture(root)
  expect(result.after).toHaveLength(10)
  expect(result.layout.scope).toEqual(['src/kept'])
}, 60_000)

const large = (index: number) => `// ${index}\n${'x'.repeat(480 * 1024)}\n`
const largeSources = Object.fromEntries(
  Array.from({ length: 36 }, (_, index) => [`src/big/l${index}.ts`, large(index)]),
)
const largeBytes = Object.values(largeSources).reduce(
  (total, content) => total + Buffer.byteLength(content),
  0,
)

it('refuses a live side above the byte cap with the size the host measured', async () => {
  const root = await fixture({ 'src/a.ts': 'export const a = 1\n' })
  await write(root, largeSources)
  const recorder = new ArchitectureScanRecorder()
  const refusal = await refusalOf(capture(root, { baseline: 'HEAD' }, recorder))
  expect(largeBytes).toBeGreaterThan(ARCHITECTURE_SCOPE.maxTotalBytes)
  expect(refusal).toMatchObject({ files: 37, bytes: largeBytes + 19 })
  expect(refusal.message).toMatch(/working tree has 37 files \(16\.\d MiB\)/)
  const liveBytes = recorder
    .metrics()
    .spans.filter((span) => span.stage === 'live-read')
    .reduce((total, span) => total + span.bytes, 0)
  expect(liveBytes).toBeLessThan(1024)
})

it('refuses a commit end above the byte cap from its listing, before reading blobs', async () => {
  const root = await fixture(largeSources)
  const recorder = new ArchitectureScanRecorder()
  const refusal = await refusalOf(
    capture(root, { baseline: 'HEAD', current: 'HEAD' }, recorder),
  )
  expect(refusal).toMatchObject({ end: 'HEAD', files: 36, bytes: largeBytes })
  expect(refusal.candidates).toEqual([{ path: 'src', files: 36, bytes: largeBytes }])
  expect(recorder.metrics().spans.map((span) => span.stage)).not.toContain('blob-read')
})

it('applies the working tree scope to a commit pair and keeps the commit mapping', async () => {
  const root = await fixture({
    'src/a/one.ts': 'export const one = 1\n',
    'src/b/two.ts': 'export const two = 2\n',
    '.hvir/architecture.json': JSON.stringify({
      version: 1,
      subsystems: [{ name: 'alpha', paths: ['src/a'] }],
    }),
  })
  await write(root, {
    '.hvir/architecture.json': JSON.stringify({ version: 1, scope: ['src/a'] }),
  })
  const result = await capture(root, { baseline: 'HEAD', current: 'HEAD' })
  expect(result.after.map((file) => file.path)).toEqual(['src/a/one.ts'])
  expect(result.layout).toMatchObject({
    origin: 'override',
    scope: ['src/a'],
    subsystems: [{ name: 'alpha', paths: ['src/a'] }],
  })
})

it('names the working tree when its layout file is invalid for a commit pair', async () => {
  const root = await fixture({ 'src/a.ts': 'export const a = 1\n' })
  await write(root, { '.hvir/architecture.json': '{"version":1,"scope":[]}' })
  await expect(capture(root, { baseline: 'HEAD', current: 'HEAD' })).rejects.toThrow(
    'Invalid .hvir/architecture.json at working tree',
  )
})
