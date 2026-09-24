import { createHash } from 'node:crypto'
import { hostPathEquals, joinHostPath } from '../../shared/host-path'
import { ARCHITECTURE_SCOPE as SCOPE } from '../../shared/architecture-review'
import type {
  ArchitectureCapture,
  ArchitectureCaptureRequest,
  ArchitectureSource,
} from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import { GitCommandContext } from '../git/git-command-context'
import { readArchitectureBlobs } from './git-blobs'
import {
  isSource,
  parseIndex,
  parseLivePaths,
  parseTree,
  selectEntries,
  type CaptureEntry,
} from './capture-entries'
import { readLiveTree } from './live-tree'
import { ArchitectureScanRecorder } from './scan-recorder'

const COMMAND_TIMEOUT = 30_000
interface Side {
  readonly sources: readonly ArchitectureSource[]
  readonly configs: readonly ArchitectureSource[]
}
type SideName = 'baseline' | 'current'

/**
 * Captures actual text pairs, never a deferred instruction to re-resolve Git revisions.
 * Every host round trip and read is recorded on the scan's recorder (ADR-063).
 */
export async function captureArchitecture(
  host: ProjectHost,
  request: ArchitectureCaptureRequest,
  signal: AbortSignal,
  recorder: ArchitectureScanRecorder = new ArchitectureScanRecorder(),
): Promise<ArchitectureCapture> {
  signal.throwIfAborted()
  validateRequest(host, request)
  const counted: Counted = (call) => {
    recorder.countHostCall()
    return call()
  }
  const context = countedGitContext(host, request, signal, counted)
  const project = await recorder.measure(
    'listing',
    () => context.project(request.root),
    () => ({ bytes: 0, items: 0 }),
  )
  if (!project) throw new Error('Architecture review requires a Git repository')
  const run = (args: readonly string[]) =>
    recorder.measure(
      'listing',
      () => context.run(request.root, args, SCOPE.maxListingBytes),
      (output) => ({
        bytes: Buffer.byteLength(output),
        items: output.split(/[\0\n]/).filter(Boolean).length,
      }),
    )
  const live = request.mode !== 'branch-point'
  const currentRevision = (await run(['rev-parse', '--verify', 'HEAD'])).trim()
  const baselineRevision = await resolveBaseline(request, currentRevision, run, () =>
    recorder.measure(
      'listing',
      () => context.defaultBranch(request.root),
      (branch) => ({ bytes: Buffer.byteLength(branch), items: 1 }),
    ),
  )
  const before = await readBlobSide(
    request.mode === 'working-tree'
      ? parseIndex(await run(['ls-files', '--stage', '-z', '--', '.']))
      : parseTree(await run(['ls-tree', '-r', '-z', baselineRevision, '--', '.'])),
    'baseline',
  )
  const after = live
    ? await readLiveSide(
        parseLivePaths(
          await run([
            'ls-files',
            '-z',
            '-t',
            '--cached',
            '--deleted',
            '--others',
            '--exclude-standard',
            '--',
            '.',
          ]),
        ),
      )
    : await readBlobSide(
        parseTree(await run(['ls-tree', '-r', '-z', currentRevision, '--', '.'])),
        'current',
      )
  signal.throwIfAborted()
  const identity = {
    root: request.root,
    mode: request.mode,
    baselineRevision,
    currentRevision: live ? 'working-tree' : currentRevision,
    scope: SCOPE,
  }
  return {
    ...identity,
    before: before.sources,
    after: after.sources,
    configs: { before: before.configs, after: after.configs },
    fingerprint: fingerprint(identity, before, after),
    capturedAt: new Date().toISOString(),
    exclusions: [
      ...SCOPE.excludedDirectories,
      '*.d.ts',
      'non-JavaScript/TypeScript sources',
      'ignored untracked files',
    ],
  }

  async function readBlobSide(entries: readonly CaptureEntry[], side: SideName) {
    const selected = selectEntries(entries)
    signal.throwIfAborted()
    const files = await recorder.measure(
      'blob-read',
      async () => {
        const blobs = await readArchitectureBlobs(
          context,
          request.root,
          selected.map((entry) => entry.object!),
        )
        return selected.map((entry) => ({
          path: entry.path,
          content: blobs.get(entry.object!)!,
          object: entry.object!,
        }))
      },
      (result) => ({ bytes: totalBytes(result), items: result.length, side }),
    )
    assertWithinByteLimit(totalBytes(files))
    return splitSide(files)
  }
  async function readLiveSide(entries: readonly CaptureEntry[]) {
    const selected = selectEntries(entries)
    signal.throwIfAborted()
    const files = await recorder.measure(
      'live-read',
      async () => [
        ...(
          await readLiveTree(
            (command, args, options) => counted(() => host.exec(command, args, options)),
            request.root,
            selected.map((entry) => entry.path),
            signal,
          )
        ).values(),
      ],
      (result) => ({ bytes: totalBytes(result), items: result.length, side: 'current' }),
    )
    return splitSide(files)
  }
  /** Identity by blob id: the ids already name every byte, so no content is hashed again. */
  function fingerprint(identity: object, ...sides: readonly Side[]): string {
    return recorder.measureSync(
      'hashing',
      () => {
        const text = JSON.stringify({
          identity,
          sides: sides.map((side) =>
            [...side.sources, ...side.configs].map((file) => [file.path, file.object]),
          ),
        })
        return { hex: createHash('sha256').update(text).digest('hex'), text }
      },
      ({ text }) => ({ bytes: Buffer.byteLength(text), items: 1 }),
    ).hex
  }
}

function splitSide(files: readonly ArchitectureSource[]): Side {
  return {
    sources: files.filter((file) => isSource(file.path)),
    configs: files.filter((file) => !isSource(file.path)),
  }
}

type Counted = <T>(call: () => Promise<T>) => Promise<T>
/** Git access for one capture, bounded per command and counted per host round trip. */
function countedGitContext(
  host: ProjectHost,
  request: ArchitectureCaptureRequest,
  signal: AbortSignal,
  counted: Counted,
): GitCommandContext {
  return new GitCommandContext(
    {
      hostId: host.hostId,
      exec: (command, args, options) =>
        counted(() =>
          host.exec(command, args, {
            ...options,
            signal,
            timeout: COMMAND_TIMEOUT,
            maxBuffer: options?.maxBuffer ?? SCOPE.maxListingBytes,
          }),
        ),
      stat: (path) => counted(() => host.stat(path)),
      readTextFile: (path) => counted(() => host.readTextFile(path, 'utf8', { signal })),
      readTextFilePrefix: (path, bytes) =>
        counted(() => host.readTextFilePrefix(path, bytes, { signal })),
    },
    request.root,
  )
}
function validateRequest(host: ProjectHost, request: ArchitectureCaptureRequest): void {
  if (
    request.root.hostId !== host.hostId ||
    !request.root.path.startsWith('/') ||
    !hostPathEquals(request.root, joinHostPath(request.root)) ||
    request.root.path.includes('\0')
  ) {
    throw new Error('Invalid architecture workspace')
  }
  if (!['working-tree', 'head', 'branch-point', 'commit'].includes(request.mode))
    throw new Error('Invalid architecture comparison')
  if (request.mode === 'commit' && !/^[a-f0-9]{7,64}$/i.test(request.revision ?? ''))
    throw new Error('Invalid pinned revision')
  if (host.connectionState !== 'connected')
    throw new Error('Reconnect the host before reviewing architecture')
}
async function resolveBaseline(
  request: ArchitectureCaptureRequest,
  head: string,
  run: (args: readonly string[]) => Promise<string>,
  defaultBranch: () => Promise<string>,
): Promise<string> {
  if (request.mode === 'working-tree') return 'index'
  if (request.mode === 'branch-point') {
    const branch = await defaultBranch()
    return (await run(['merge-base', head, branch])).trim()
  }
  return (
    await run([
      'rev-parse',
      '--verify',
      `${request.mode === 'commit' ? request.revision : head}^{commit}`,
    ])
  ).trim()
}
function assertWithinByteLimit(bytes: number): void {
  if (bytes > SCOPE.maxTotalBytes)
    throw new Error('Architecture scan exceeds the total source byte limit')
}
function totalBytes(files: readonly ArchitectureSource[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
}
