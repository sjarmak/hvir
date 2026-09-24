import { createHash } from 'node:crypto'
import {
  ARCHITECTURE_LIVE_REVISION as LIVE_REVISION,
  ARCHITECTURE_SCOPE as SCOPE,
  ARCHITECTURE_WORKING_TREE,
} from '../../shared/architecture-review'
import { ARCHITECTURE_LAYOUT_FILE } from '../../shared/architecture-layout'
import { gitError } from '../git/git-command-context'
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
import { LiveTreeOverCapError, readLiveTree } from './live-tree'
import { readCaptureLayout, scopedLayout } from './capture-layout'
import { assertWithinScopeCap, liveBytesRefusal } from './scope-cap'
import { ArchitectureScanRecorder } from './scan-recorder'

interface Side {
  readonly sources: readonly ArchitectureSource[]
  readonly configs: readonly ArchitectureSource[]
}
type SideName = 'baseline' | 'current'
/** Tracked, deleted and unignored untracked paths of the live tree, before a pathspec. */
const LIVE_LISTING = [
  'ls-files',
  '-z',
  '-t',
  '--cached',
  '--deleted',
  '--others',
  '--exclude-standard',
  '--',
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
  const list = (args: readonly string[]) =>
    recorder.measure(
      'listing',
      () => boundedListing(context, request.root, args),
      (output) => ({
        bytes: Buffer.byteLength(output),
        items: output.split(/[\0\n]/).filter(Boolean).length,
      }),
    )
  const ends = await resolveArchitectureEnds(
    request,
    measuredEndsGit(recorder, context, request.root),
  )
  const currentEntries = ends.currentCommit
    ? parseTree(await list(treeListing(ends.currentCommit)))
    : parseLivePaths(await list(liveListing('.')))
  const captured = await captureLayouts()
  const { layout } = captured
  const current = selectEntries(currentEntries, layout)
  const baseline = selectEntries(
    parseTree(await list(treeListing(ends.baselineRevision))),
    layout,
  )
  assertWithinScopeCap(current, { end: ends.currentRef, scope: layout.scope })
  assertWithinScopeCap(baseline, { end: ends.baselineRef, scope: layout.scope })
  const after = ends.currentCommit
    ? await readBlobSide(current, 'current')
    : splitSide(await readLiveSide(current))
  const before = await readBlobSide(baseline, 'baseline')
  signal.throwIfAborted()
  // Refs are labels; the fingerprint names only the commits and bytes they resolved to.
  const identity = {
    root: request.root,
    baselineRevision: ends.baselineRevision,
    currentRevision: ends.currentCommit ?? LIVE_REVISION,
    scope: SCOPE,
    layout: captured.identity,
  }
  return {
    ...identity,
    baselineRef: ends.baselineRef,
    currentRef: ends.currentRef,
    before: before.sources,
    after: after.sources,
    configs: { before: before.configs, after: after.configs },
    layout,
    fingerprint: fingerprint(recorder, identity, before, after),
    capturedAt: new Date().toISOString(),
    exclusions: CAPTURE_EXCLUSIONS,
  }

  /**
   * Subsystem mapping follows the Current end; the scope is the reviewer's choice and is
   * always read from the working tree's copy, so it also narrows a pair of commits.
   */
  async function captureLayouts() {
    const mapping = await readCaptureLayout(currentEntries, ends.currentRef, (entry) =>
      ends.currentCommit
        ? readBlobs([entry], 'current').then((files) => files[0]!)
        : readLive([entry]).then((files) => files[0]!),
    )
    const scope = ends.currentCommit
      ? await readCaptureLayout(
          parseLivePaths(await list(liveListing(ARCHITECTURE_LAYOUT_FILE))),
          ARCHITECTURE_WORKING_TREE,
          (entry) => readLive([entry]).then((files) => files[0]!),
        )
      : mapping
    return scopedLayout(mapping, scope)
  }
  async function readBlobSide(entries: readonly CaptureEntry[], side: SideName) {
    return splitSide(await readBlobs(entries, side))
  }
  async function readLiveSide(entries: readonly CaptureEntry[]) {
    try {
      return await readLive(entries)
    } catch (error) {
      if (!(error instanceof LiveTreeOverCapError)) throw error
      throw liveBytesRefusal(entries, error.bytes, {
        end: ends.currentRef,
        scope: layout.scope,
      })
    }
  }
  function readBlobs(selected: readonly CaptureEntry[], side: SideName) {
    signal.throwIfAborted()
    return recorder.measure(
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
  }
  function readLive(selected: readonly CaptureEntry[]) {
    signal.throwIfAborted()
    return recorder.measure(
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
  }
}

const CAPTURE_EXCLUSIONS: readonly string[] = [
  ...SCOPE.excludedDirectories,
  '*.d.ts',
  'sources other than JavaScript, TypeScript, Python and Go',
  '*.pyi',
  'ignored untracked files',
]

/** Identity by blob id: the ids already name every byte, so no content is hashed again. */
function fingerprint(
  recorder: ArchitectureScanRecorder,
  identity: object,
  ...sides: readonly Side[]
): string {
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

function treeListing(revision: string): readonly string[] {
  return ['ls-tree', '-r', '-l', '-z', revision, '--', '.']
}
function liveListing(pathspec: string): readonly string[] {
  return [...LIVE_LISTING, pathspec]
}

/** A listing past its bound is refused by name; a partial listing would drop files. */
async function boundedListing(
  context: ReturnType<typeof architectureGitContext>,
  root: ArchitectureCaptureRequest['root'],
  args: readonly string[],
): Promise<string> {
  const result = await context.readOnly(root, args, {
    maxBuffer: SCOPE.maxListingBytes,
    allowTruncatedOutput: true,
  })
  if (result.outputTruncated)
    throw new Error(
      `The Git listing for this architecture scan is larger than ${SCOPE.maxListingBytes / (1024 * 1024)} MiB (git ${args.join(' ')})`,
    )
  if (result.code !== 0) throw gitError(args, result.stderr, result.code)
  return result.stdout
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
function totalBytes(files: readonly ArchitectureSource[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
}
