import { createHash } from 'node:crypto'
import { containsHostPath, hostPathEquals, joinHostPath } from '../../shared/host-path'
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
  parsePaths,
  parseTree,
  selectEntries,
  type CaptureEntry,
} from './capture-entries'
import { ArchitectureScanRecorder } from './scan-recorder'

const COMMAND_TIMEOUT = 30_000
const READ_CONCURRENCY = 8
interface Side {
  readonly sources: readonly ArchitectureSource[]
  readonly configs: readonly ArchitectureSource[]
}
type SideRead = 'blob' | 'live' | 'recheck'
type Contents = ReadonlyMap<string, string>

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
  const { project, canonicalRoot } = await recorder.measure(
    'listing',
    async () => ({
      project: await context.project(request.root),
      canonicalRoot: await counted(() => host.realpath(request.root)),
    }),
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
  const baselineRevision = await resolveBaseline(context, request, currentRevision, run)
  const beforeEntries =
    request.mode === 'working-tree'
      ? parseIndex(await run(['ls-files', '--stage', '-z', '--', '.']))
      : parseTree(await run(['ls-tree', '-r', '-z', baselineRevision, '--', '.']))
  const before = await readSide(beforeEntries, 'blob', 'baseline')
  const currentEntries = async () =>
    live
      ? parsePaths(
          await run([
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard',
            '--',
            '.',
          ]),
        )
      : parseTree(await run(['ls-tree', '-r', '-z', currentRevision, '--', '.']))
  const after = await readSide(await currentEntries(), live ? 'live' : 'blob', 'current')
  // A live tree is not atomic. Refuse a moving read rather than label mixed evidence current.
  if (live) {
    const check = await readSide(await currentEntries(), 'recheck', 'current')
    if (digest(after) !== digest(check))
      throw new Error('Sources changed during capture; refresh architecture review')
  }
  signal.throwIfAborted()
  const identity = {
    root: request.root,
    mode: request.mode,
    baselineRevision,
    currentRevision: live ? 'working-tree' : currentRevision,
    scope: SCOPE,
    configFingerprint: digest({ before: before.configs, after: after.configs }),
    before,
    after,
  }
  return {
    ...identity,
    before: before.sources,
    after: after.sources,
    fingerprint: digest(identity),
    capturedAt: new Date().toISOString(),
    exclusions: [
      ...SCOPE.excludedDirectories,
      '*.d.ts',
      'non-JavaScript/TypeScript sources',
      'ignored untracked files',
    ],
  }

  async function readSide(
    entries: readonly CaptureEntry[],
    read: SideRead,
    side: 'baseline' | 'current',
  ): Promise<Side> {
    const selected = selectEntries(entries)
    signal.throwIfAborted()
    const contents = await recorder.measure(
      read === 'blob' ? 'blob-read' : read === 'live' ? 'live-read' : 'live-recheck',
      () => (read === 'blob' ? readBlobs(selected) : readLive(selected)),
      (result) => ({ bytes: totalBytes(result), items: result.size, side }),
    )
    const files = selected.flatMap((entry) => {
      const content = contents.get(entry.path)
      return content === undefined ? [] : [{ path: entry.path, content }]
    })
    return {
      sources: files.filter((file) => isSource(file.path)),
      configs: files.filter((file) => !isSource(file.path)),
    }
  }
  async function readBlobs(entries: readonly CaptureEntry[]): Promise<Contents> {
    const blobs = await readArchitectureBlobs(
      context,
      request.root,
      entries.map((entry) => entry.object!),
    )
    const contents = new Map(
      entries.map((entry) => [entry.path, blobs.get(entry.object!)!]),
    )
    assertWithinByteLimit(totalBytes(contents))
    return contents
  }
  async function readLive(entries: readonly CaptureEntry[]): Promise<Contents> {
    const contents = new Map<string, string>()
    let bytes = 0
    for (let offset = 0; offset < entries.length; offset += READ_CONCURRENCY) {
      signal.throwIfAborted()
      const batch = await Promise.all(
        entries.slice(offset, offset + READ_CONCURRENCY).map(async (entry) => ({
          path: entry.path,
          content: await liveText(entry.path),
        })),
      )
      for (const file of batch) {
        if (file.content === undefined) continue
        bytes += Buffer.byteLength(file.content)
        assertWithinByteLimit(bytes)
        contents.set(file.path, file.content)
      }
    }
    return contents
  }
  async function liveText(relative: string): Promise<string | undefined> {
    const path = joinHostPath(request.root, relative)
    try {
      const stat = await counted(() => host.stat(path))
      if (stat.type !== 'file')
        throw new Error(`Unsupported symbolic link or non-file source: ${relative}`)
      const canonical = await counted(() => host.realpath(path))
      if (!containsHostPath(canonicalRoot, canonical))
        throw new Error('Source escapes workspace through a symlink')
      const result = await counted(() =>
        host.readTextFilePrefix(path, SCOPE.maxFileBytes, { signal }),
      )
      if (!result.complete || result.validUtf8 === false)
        throw new Error(`Unsupported large or invalid source: ${relative}`)
      return result.content
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }
  function digest(value: unknown): string {
    return recorder.measureSync(
      'hashing',
      () => {
        const text = JSON.stringify(value)
        return { hex: createHash('sha256').update(text).digest('hex'), text }
      },
      ({ text }) => ({ bytes: Buffer.byteLength(text), items: 1 }),
    ).hex
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
  context: GitCommandContext,
  request: ArchitectureCaptureRequest,
  head: string,
  run: (args: readonly string[]) => Promise<string>,
): Promise<string> {
  if (request.mode === 'working-tree') return 'index'
  if (request.mode === 'branch-point')
    return (
      await run(['merge-base', head, await context.defaultBranch(request.root)])
    ).trim()
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
function totalBytes(contents: Contents): number {
  let bytes = 0
  for (const content of contents.values()) bytes += Buffer.byteLength(content)
  return bytes
}
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
