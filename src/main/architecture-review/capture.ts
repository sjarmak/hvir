import { createHash } from 'node:crypto'
import {
  ARCHITECTURE_LIVE_REVISION as LIVE_REVISION,
  ARCHITECTURE_SCOPE as SCOPE,
} from '../../shared/architecture-review'
import type {
  ArchitectureCapture,
  ArchitectureCaptureRequest,
  ArchitectureSource,
} from '../../shared/architecture-review'
import type { ProjectHost } from '../project-host/project-host'
import {
  architectureGitContext,
  validateArchitectureRoot,
  type Counted,
} from './git-context'
import { readArchitectureBlobs } from './git-blobs'
import {
  isSource,
  parseLivePaths,
  parseTree,
  selectEntries,
  type CaptureEntry,
} from './capture-entries'
import { resolveArchitectureEnds, validateArchitectureEnds, type EndsGit } from './ends'
import { readLiveTree } from './live-tree'
import { ArchitectureScanRecorder } from './scan-recorder'

interface Side {
  readonly sources: readonly ArchitectureSource[]
  readonly configs: readonly ArchitectureSource[]
}
type SideName = 'baseline' | 'current'
/** Tracked, deleted and unignored untracked paths of the live tree. */
const LIVE_LISTING = [
  'ls-files',
  '-z',
  '-t',
  '--cached',
  '--deleted',
  '--others',
  '--exclude-standard',
  '--',
  '.',
] as const

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
  validateArchitectureRequest(host, request)
  const counted: Counted = (call) => {
    recorder.countHostCall()
    return call()
  }
  const context = architectureGitContext(host, request.root, signal, counted)
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
  const ends = await resolveArchitectureEnds(
    request,
    measuredEndsGit(recorder, context, request.root),
  )
  const before = await readBlobSide(
    parseTree(await run(['ls-tree', '-r', '-z', ends.baselineRevision, '--', '.'])),
    'baseline',
  )
  const after = ends.currentCommit
    ? await readBlobSide(
        parseTree(await run(['ls-tree', '-r', '-z', ends.currentCommit, '--', '.'])),
        'current',
      )
    : await readLiveSide(parseLivePaths(await run(LIVE_LISTING)))
  signal.throwIfAborted()
  // Refs are labels; the fingerprint names only the commits and bytes they resolved to.
  const identity = {
    root: request.root,
    baselineRevision: ends.baselineRevision,
    currentRevision: ends.currentCommit ?? LIVE_REVISION,
    scope: SCOPE,
  }
  return {
    ...identity,
    baselineRef: ends.baselineRef,
    currentRef: ends.currentRef,
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

/** End resolution through the scan's git context, recorded as listing work. */
function measuredEndsGit(
  recorder: ArchitectureScanRecorder,
  context: ReturnType<typeof architectureGitContext>,
  root: ArchitectureCaptureRequest['root'],
): EndsGit {
  return {
    tryRun: (args) =>
      recorder.measure(
        'listing',
        () => context.tryRun(root, args),
        (output) => ({ bytes: Buffer.byteLength(output ?? ''), items: 1 }),
      ),
    defaultBranch: () =>
      recorder.measure(
        'listing',
        () => context.defaultBranch(root),
        (branch) => ({ bytes: Buffer.byteLength(branch), items: 1 }),
      ),
  }
}

function splitSide(files: readonly ArchitectureSource[]): Side {
  return {
    sources: files.filter((file) => isSource(file.path)),
    configs: files.filter((file) => !isSource(file.path)),
  }
}

export function validateArchitectureRequest(
  host: ProjectHost,
  request: ArchitectureCaptureRequest,
): void {
  validateArchitectureRoot(host, request.root)
  validateArchitectureEnds(request)
}
function assertWithinByteLimit(bytes: number): void {
  if (bytes > SCOPE.maxTotalBytes)
    throw new Error('Architecture scan exceeds the total source byte limit')
}
function totalBytes(files: readonly ArchitectureSource[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
}
