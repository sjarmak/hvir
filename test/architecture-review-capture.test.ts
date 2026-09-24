import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import type { ExecOptions, ProjectHost } from '../src/main/project-host/project-host'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'
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

it('records listing, blob, one live-read and hashing spans for a working-tree scan', async () => {
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
  expect(stagesOf(metrics)).toEqual(['blob-read', 'hashing', 'listing', 'live-read'])
  const span = (stage: string) => metrics.spans.find((entry) => entry.stage === stage)!
  const bytes = (files: readonly { content: string }[]) =>
    files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
  expect(span('blob-read')).toMatchObject({
    side: 'baseline',
    items: 1,
    bytes: bytes(capture.before),
    hostCalls: 1,
  })
  // The whole live side, consistency check included, is one host command.
  expect(span('live-read')).toMatchObject({
    side: 'current',
    items: 2,
    bytes: bytes(capture.after),
    hostCalls: 1,
  })
  expect(
    metrics.spans.filter((entry) => entry.stage === 'listing').length,
  ).toBeGreaterThan(2)
})

it('reads any number of live files in one host command', async () => {
  const f = await fixture()
  for (let index = 0; index < 40; index += 1)
    await writeFile(join(f.root, `src/m${index}.ts`), `export const m = ${index}\n`)
  const recorder = new ArchitectureScanRecorder()
  const capture = await captureArchitecture(
    f.host,
    { root: localPath(f.root), mode: 'head' },
    new AbortController().signal,
    recorder,
  )
  expect(capture.after).toHaveLength(41)
  const live = recorder.metrics().spans.filter((span) => span.stage === 'live-read')
  expect(live).toEqual([expect.objectContaining({ items: 41, hostCalls: 1 })])
})

it('carries Git blob ids and fingerprints ids rather than whole contents', async () => {
  const f = await fixture()
  await writeFile(
    join(f.root, 'src/big.ts'),
    `export const big = '${'x'.repeat(300_000)}'\n`,
  )
  await writeFile(join(f.root, 'tsconfig.json'), '{"compilerOptions":{}}')
  const recorder = new ArchitectureScanRecorder()
  const capture = await captureArchitecture(
    f.host,
    { root: localPath(f.root), mode: 'head' },
    new AbortController().signal,
    recorder,
  )
  for (const file of [...capture.after, ...capture.configs.after])
    expect(file.object).toBe(git(f.root, 'hash-object', '--no-filters', file.path))
  for (const file of capture.before)
    expect(file.object).toBe(git(f.root, 'rev-parse', `HEAD:${file.path}`))
  expect(capture.configs.after.map((file) => file.path)).toEqual(['tsconfig.json'])
  const hashed = recorder
    .metrics()
    .spans.filter((span) => span.stage === 'hashing')
    .reduce((total, span) => total + span.bytes, 0)
  expect(hashed).toBeGreaterThan(0)
  expect(hashed).toBeLessThan(4_096)
  const again = await f.capture('head')
  expect(again.fingerprint).toBe(capture.fingerprint)
})

/** A host whose `tar` edits a live source just before or just after it archives. */
async function hostEditingDuringRead(root: string, when: 'before' | 'after') {
  const shims = await mkdtemp(join(tmpdir(), 'hvir-architecture-shim-'))
  roots.push(shims)
  const tar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim()
  const edit = `printf 'export const value = 9\\n' > '${join(root, 'src/a.ts')}'`
  const body =
    when === 'before'
      ? `${edit}\nexec '${tar}' "$@"`
      : `'${tar}' "$@"\nstatus=$?\n${edit}\nexit $status`
  await writeFile(join(shims, 'tar'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const local = new LocalHost()
  const host = new Proxy(local, {
    get(target, property, receiver) {
      if (property !== 'exec') {
        const value: unknown = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? (value.bind(target) as unknown) : value
      }
      return (command: string, args: readonly string[], options?: ExecOptions) =>
        target.exec(command, args, {
          ...options,
          env: { ...options?.env, PATH: `${shims}:${process.env.PATH ?? ''}` },
        })
    },
  })
  return host
}

it.each([['before'], ['after']] as const)(
  'refuses a live tree edited %s its bytes are streamed',
  async (when) => {
    const f = await fixture()
    await writeFile(join(f.root, 'src/a.ts'), 'export const value = 5\n')
    const host = await hostEditingDuringRead(f.root, when)
    await expect(
      captureArchitecture(
        host,
        { root: localPath(f.root), mode: 'head' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Sources changed during capture')
  },
)

it('resolves path aliases through the tsconfig captured with each end', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'src/b.ts'), 'export const b = 1\n')
  await writeFile(join(f.root, 'src/a.ts'), "import { b } from '@app/b'\n")
  await writeFile(
    join(f.root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
  )
  const { analysis } = await analyzeCaptureTimed(await f.capture('working-tree'))
  expect(analysis.after.imports).toEqual([
    expect.objectContaining({
      specifier: '@app/b',
      resolution: 'internal',
      target: 'src/b.ts',
    }),
  ])
  expect(analysis.after.diagnostics).toEqual([])
  expect(analysis.before.diagnostics).toEqual([
    expect.objectContaining({ file: '(capture)' }),
  ])
})

it('refuses invalid UTF-8 and sources reached through a symbolic link directory', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'src/bad.ts'), Buffer.from([0x65, 0xff, 0xfe, 0x0a]))
  await writeFile(join(f.root, 'src/z.ts'), 'export const z = 1\n')
  await expect(f.capture('head')).rejects.toThrow(
    'Unsupported large or invalid source: src/bad.ts',
  )
  await rm(join(f.root, 'src/bad.ts'))
  const outside = await mkdtemp(join(tmpdir(), 'hvir-architecture-outside-'))
  roots.push(outside)
  await writeFile(join(outside, 'a.ts'), 'export const leaked = 1\n')
  await writeFile(join(outside, 'z.ts'), 'export const z = 1\n')
  await rm(join(f.root, 'src'), { recursive: true })
  await symlink(outside, join(f.root, 'src'))
  await expect(f.capture('head')).rejects.toThrow(
    'Unsupported symbolic link in scan: src',
  )
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

/** LocalHost with every host round trip the capture can make counted. */
function countingHost(): { host: ProjectHost; calls: () => number } {
  const local = new LocalHost()
  let calls = 0
  const counted = new Set([
    'exec',
    'stat',
    'realpath',
    'readTextFile',
    'readTextFilePrefix',
  ])
  const host = new Proxy(local, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (!counted.has(String(property))) return value.bind(target) as unknown
      return (...args: unknown[]) => {
        calls += 1
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { host, calls: () => calls }
}

it('credits every host round trip to a span in every comparison mode', async () => {
  const f = await fixture()
  git(f.root, 'switch', '-c', 'feature')
  await writeFile(join(f.root, 'src/a.ts'), 'export const value = 2\n')
  git(f.root, 'commit', '-am', 'change')
  await writeFile(join(f.root, 'src/b.ts'), 'export const b = 22\n')
  const modes = ['branch-point', 'working-tree', 'head', 'commit'] as const
  for (const mode of modes) {
    const { host, calls } = countingHost()
    const recorder = new ArchitectureScanRecorder()
    await captureArchitecture(
      host,
      {
        root: localPath(f.root),
        mode,
        revision: mode === 'commit' ? f.baseline : undefined,
      },
      new AbortController().signal,
      recorder,
    )
    const credited = recorder
      .metrics()
      .spans.reduce((total, span) => total + span.hostCalls, 0)
    expect({ mode, credited }).toEqual({ mode, credited: calls() })
    expect(calls()).toBeGreaterThan(0)
  }
})
