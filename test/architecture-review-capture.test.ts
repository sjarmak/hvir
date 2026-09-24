import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import { expectMonotoneMetrics, stagesOf } from './architecture-scan-metrics-fixture'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const value = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  const baseline = git(root, 'rev-parse', 'HEAD')
  const host = new LocalHost()
  return {
    root,
    host,
    baseline,
    capture: (
      mode: 'head' | 'working-tree' | 'branch-point' | 'commit',
      revision?: string,
    ) =>
      captureArchitecture(
        host,
        { root: localPath(root), mode, revision },
        new AbortController().signal,
      ),
  }
}

function hostBackedByLocal(local: LocalHost, hostId = 'ssh-test'): ProjectHost {
  const remoteId = asHostId(hostId)
  const localize = (path: { readonly hostId: unknown; readonly path: string }) => {
    if (path.hostId !== remoteId)
      throw new Error('remote fake received foreign host path')
    return localPath(path.path)
  }
  const unused = () => Promise.reject(new Error('not used by architecture capture'))
  return {
    hostId: remoteId,
    connectionState: 'connected',
    watchTier: 'polling',
    fileDeletion: { capability: 'unavailable' },
    connect: () => Promise.resolve(),
    dispose: () => local.dispose(),
    onConnectionState: (cb) => {
      cb('connected')
      return () => undefined
    },
    defaultShell: () => local.defaultShell(),
    exec: (command, args, options) =>
      local.exec(command, args, {
        ...options,
        cwd: options?.cwd ? localize(options.cwd) : undefined,
      }),
    execStream: () => {
      throw new Error('not used by architecture capture')
    },
    spawnPty: unused,
    connectLoopback: unused,
    readFile: unused,
    readTextFile: (path, encoding, options) =>
      local.readTextFile(localize(path), encoding, options),
    readTextFilePrefix: (path, maxBytes, options) =>
      local.readTextFilePrefix(localize(path), maxBytes, options),
    writeFile: unused,
    createFileExclusive: unused,
    createDirectoryExclusive: unused,
    removeFile: unused,
    readdir: unused,
    stat: (path) => local.stat(localize(path)),
    realpath: async (path) =>
      hostPath(remoteId, (await local.realpath(localize(path))).path),
    watch: () => {
      throw new Error('not used by architecture capture')
    },
  }
}
it('captures index -> live independently from HEAD -> live and retains exact evidence', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 2\n')
  git(f.root, 'add', '.')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 3\n')
  const index = await f.capture('working-tree')
  const head = await f.capture('head')
  expect(index.before[0]?.content).toContain('= 2')
  expect(head.before[0]?.content).toContain('= 1')
  expect(index.after[0]?.content).toContain('= 3')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 4\n')
  expect(index.after[0]?.content).toContain('= 3')
  expect((await f.capture('working-tree')).fingerprint).not.toBe(index.fingerprint)
})
it('branch-point excludes dirty files; explicit commit comparison includes them', async () => {
  const f = await fixture()
  git(f.root, 'switch', '-c', 'feature')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 2\n')
  git(f.root, 'add', '.')
  git(f.root, 'commit', '-m', 'change')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 3\n')
  const branch = await f.capture('branch-point')
  const pinned = await f.capture('commit', f.baseline)
  expect(branch.before[0]?.content).toContain('= 1')
  expect(branch.after[0]?.content).toContain('= 2')
  expect(pinned.after[0]?.content).toContain('= 3')
  expect(pinned.baselineRevision).toBe(f.baseline)
})
it('captures renamed, deleted, untracked and excluded files truthfully', async () => {
  const f = await fixture()
  await rename(join(f.root, 'src/a.ts'), join(f.root, 'src/renamed.ts'))
  await writeFile(join(f.root, 'src/new.js'), 'export default 1')
  await mkdir(join(f.root, 'node_modules'))
  await writeFile(join(f.root, 'node_modules/ignored.ts'), 'bad')
  const result = await f.capture('head')
  expect(result.before.map((f) => f.path)).toEqual(['src/a.ts'])
  expect(result.after.map((f) => f.path)).toEqual(['src/new.js', 'src/renamed.ts'])
  expect(result.exclusions).toContain('node_modules')
})
it('fingerprints config and rejects path escapes, cancellation and invalid baselines', async () => {
  const f = await fixture()
  const first = await f.capture('head')
  await writeFile(join(f.root, 'tsconfig.json'), '{"compilerOptions":{}}')
  expect((await f.capture('head')).fingerprint).not.toBe(first.fingerprint)
  await expect(f.capture('commit', '--help')).rejects.toThrow(/revision/i)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(
    captureArchitecture(
      f.host,
      { root: localPath(f.root), mode: 'head' },
      controller.signal,
    ),
  ).rejects.toThrow('cancelled')
  await symlink('/etc/passwd', join(f.root, 'src/escape.ts'))
  await expect(f.capture('head')).rejects.toThrow(/symbolic|symlink/)
})

it('captures identical bytes and revisions through a host-qualified remote transport', async () => {
  const f = await fixture()
  const remote = hostBackedByLocal(f.host)
  const remoteRoot = hostPath(remote.hostId, f.root)
  const localCapture = await captureArchitecture(
    f.host,
    { root: localPath(f.root), mode: 'head' },
    new AbortController().signal,
  )
  const remoteCapture = await captureArchitecture(
    remote,
    { root: remoteRoot, mode: 'head' },
    new AbortController().signal,
  )
  expect(remoteCapture.root.hostId).toBe(remote.hostId)
  expect(remoteCapture.baselineRevision).toBe(localCapture.baselineRevision)
  expect(remoteCapture.currentRevision).toBe(localCapture.currentRevision)
  expect(remoteCapture.before).toEqual(localCapture.before)
  expect(remoteCapture.after).toEqual(localCapture.after)
  // The fingerprint includes the host-qualified root, so equal evidence on
  // different transports remains distinguishable to stale-review guards.
  expect(remoteCapture.fingerprint).not.toBe(localCapture.fingerprint)
})

it('records listing, blob, live-read, recheck and hashing spans for a working-tree scan', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'src/b.ts'), 'export const b = 22\n')
  const recorder = new ArchitectureScanRecorder()
  const capture = await captureArchitecture(
    f.host,
    { root: localPath(f.root), mode: 'working-tree' },
    new AbortController().signal,
    recorder,
  )
  const metrics = recorder.metrics()
  expectMonotoneMetrics(metrics)
  expect(stagesOf(metrics)).toEqual([
    'blob-read',
    'hashing',
    'listing',
    'live-read',
    'live-recheck',
  ])
  const span = (stage: string) => metrics.spans.find((entry) => entry.stage === stage)!
  const bytes = (files: readonly { content: string }[]) =>
    files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
  expect(span('blob-read')).toMatchObject({
    side: 'baseline',
    items: 1,
    bytes: bytes(capture.before),
    hostCalls: 1,
  })
  // Every live file costs a stat, a realpath and a read on the host.
  expect(span('live-read')).toMatchObject({
    side: 'current',
    items: 2,
    bytes: bytes(capture.after),
    hostCalls: 6,
  })
  expect(span('live-recheck')).toMatchObject({ items: 2, hostCalls: 6 })
  expect(
    metrics.spans.filter((entry) => entry.stage === 'listing').length,
  ).toBeGreaterThan(2)
})

it('reads both commit ends from Git objects without live reads in branch-point mode', async () => {
  const f = await fixture()
  git(f.root, 'switch', '-c', 'feature')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 2\n')
  git(f.root, 'commit', '-am', 'change')
  const recorder = new ArchitectureScanRecorder()
  await captureArchitecture(
    f.host,
    { root: localPath(f.root), mode: 'branch-point' },
    new AbortController().signal,
    recorder,
  )
  const metrics = recorder.metrics()
  expectMonotoneMetrics(metrics)
  expect(stagesOf(metrics)).toEqual(['blob-read', 'hashing', 'listing'])
  expect(
    metrics.spans
      .filter((entry) => entry.stage === 'blob-read')
      .map((entry) => entry.side),
  ).toEqual(['baseline', 'current'])
})
