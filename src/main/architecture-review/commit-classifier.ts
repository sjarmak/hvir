import {
  ARCHITECTURE_CLASSIFY_LIMIT,
  type ArchitectureCommitClassification,
  type ArchitectureCommitClassifyRequest,
  type ArchitectureCommitChange,
} from '../../shared/architecture-review'
import type { ArchitectureSourceFile } from '../../shared/architecture-analysis'
import type { HostPath } from '../../shared/host-path'
import {
  ARCHITECTURE_DEFAULT_LAYOUT,
  ARCHITECTURE_LAYOUT_FILE,
  parseArchitectureLayout,
  type ArchitectureLayout,
} from '../../shared/architecture-layout'
import type { ProjectHost } from '../project-host/project-host'
import { parseTree } from './capture-entries'
import {
  classifyCommitChange,
  COMMIT_CHANGE_CLASSIFIER_VERSION,
  modifiedSources,
  parseCommitDiffs,
  structurallyChanged,
  type CommitDiff,
  type CommitDiffEntry,
  type ImportSignature,
} from './commit-change'
import { CommitChangeCache, type CommitChangeKey } from './commit-change-cache'
import { readArchitectureBlobs } from './git-blobs'
import { architectureGitContext, validateArchitectureRoot } from './git-context'
import type { ModuleImportsResult } from './module-imports'

export type ModuleImportsPort = (
  sources: readonly ArchitectureSourceFile[],
  root: HostPath,
  signal: AbortSignal,
) => Promise<ModuleImportsResult>

export interface ArchitectureCommitClassifierPorts {
  readonly imports: ModuleImportsPort
  readonly cacheEntries?: number
}

const HASH = /^[a-f0-9]{40,64}$/
const MAX_OUTPUT = 16 * 1024 * 1024
const MAX_MODULES_PER_COMMIT = 200
const DEFAULT_CACHE_ENTRIES = 4_000
const RAW_LOG = [
  'log',
  '--no-walk=unsorted',
  '--diff-merges=first-parent',
  '--raw',
  '-z',
  '--no-abbrev',
  '--no-renames',
  '--format=%x1e%H%x1f%P',
] as const

interface Pending {
  readonly diff: CommitDiff
  readonly key: CommitChangeKey
  readonly modified: readonly CommitDiffEntry[]
}

export class ArchitectureCommitClassifier {
  private readonly cache: CommitChangeCache
  private scanners = COMMIT_CHANGE_CLASSIFIER_VERSION

  constructor(private readonly ports: ArchitectureCommitClassifierPorts) {
    this.cache = new CommitChangeCache(ports.cacheEntries ?? DEFAULT_CACHE_ENTRIES)
  }

  async classify(
    host: ProjectHost,
    request: ArchitectureCommitClassifyRequest,
    signal: AbortSignal,
  ): Promise<readonly ArchitectureCommitClassification[]> {
    validateArchitectureRoot(host, request.root)
    validateRevisions(request.revisions)
    if (request.revisions.length === 0) return []
    const root = request.root
    const context = architectureGitContext(host, root, signal)
    const run = (args: readonly string[]) => context.run(root, args, MAX_OUTPUT)
    const layout = await readHeadLayout(run, (objects) =>
      readArchitectureBlobs(context, root, objects),
    )
    const diffs = parseCommitDiffs(await run([...RAW_LOG, ...request.revisions, '--']))
    const byRevision = new Map(diffs.map((diff) => [diff.revision, diff]))
    const answers = new Map<string, ArchitectureCommitChange>()
    const pending: Pending[] = []
    for (const revision of new Set(request.revisions)) {
      const diff = byRevision.get(revision)
      if (!diff) throw new Error(`Git did not describe commit ${revision}`)
      const key = this.keyOf(root, diff, layout.id)
      const cached =
        this.cache.lookup({ ...key, scanners: COMMIT_CHANGE_CLASSIFIER_VERSION }) ??
        this.cache.lookup(key)
      if (cached !== undefined) {
        answers.set(revision, cached)
        continue
      }
      const structural = this.decideWithoutReading(diff, layout.layout)
      if (structural) {
        this.cache.store(
          { ...key, scanners: COMMIT_CHANGE_CLASSIFIER_VERSION },
          structural,
        )
        answers.set(revision, structural)
        continue
      }
      pending.push({ diff, key, modified: modifiedSources(diff.entries, layout.layout) })
    }
    if (pending.length > 0) {
      const table = await this.importsOf(pending, root, context, signal)
      for (const entry of pending) {
        const change = table
          ? classifyCommitChange(entry.diff.entries, layout.layout, table)
          : 'unclassified'
        if (table) this.cache.store({ ...entry.key, scanners: this.scanners }, change)
        answers.set(entry.diff.revision, change)
      }
    }
    return request.revisions.map((revision) => {
      const diff = byRevision.get(revision)!
      return {
        revision,
        parent: diff.parents[0] ?? null,
        merge: diff.parents.length > 1,
        change: answers.get(revision)!,
      }
    })
  }

  private keyOf(root: HostPath, diff: CommitDiff, layout: string): CommitChangeKey {
    return {
      root,
      revision: diff.revision,
      parent: diff.parents[0] ?? null,
      scanners: this.scanners,
      layout,
    }
  }

  private decideWithoutReading(
    diff: CommitDiff,
    layout: ArchitectureLayout,
  ): ArchitectureCommitChange | undefined {
    if (structurallyChanged(diff.entries, layout)) return 'architecture'
    const modified = modifiedSources(diff.entries, layout)
    if (modified.length === 0) return 'none'
    if (modified.length > MAX_MODULES_PER_COMMIT) return 'unclassified'
    return undefined
  }

  private async importsOf(
    pending: readonly Pending[],
    root: HostPath,
    context: ReturnType<typeof architectureGitContext>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly ImportSignature[] | null> | undefined> {
    const wanted = new Map<string, string>()
    for (const entry of pending)
      for (const modified of entry.modified) {
        wanted.set(modified.before, modified.path)
        wanted.set(modified.after, modified.path)
      }
    const contents = await readArchitectureBlobs(context, root, [...wanted.keys()]).catch(
      (error: unknown) => {
        if (error instanceof Error && /Unsupported large/.test(error.message))
          return undefined
        throw error
      },
    )
    if (!contents) return undefined
    const sources = [...wanted].map(([object, path]) => ({
      path,
      object,
      content: contents.get(object) ?? '',
    }))
    const result = await this.ports.imports(sources, root, signal)
    this.scanners = result.scanners
    return new Map(result.imports.map((entry) => [entry.object, entry.imports]))
  }
}

function validateRevisions(revisions: readonly string[]): void {
  if (revisions.length > ARCHITECTURE_CLASSIFY_LIMIT)
    throw new Error(`Classify at most ${ARCHITECTURE_CLASSIFY_LIMIT} commits per request`)
  for (const revision of revisions)
    if (!HASH.test(revision)) throw new Error('Classify needs full commit revisions')
}

async function readHeadLayout(
  run: (args: readonly string[]) => Promise<string>,
  read: (objects: readonly string[]) => Promise<ReadonlyMap<string, string>>,
): Promise<{ readonly id: string; readonly layout: ArchitectureLayout }> {
  const [entry] = parseTree(
    await run(['ls-tree', '-z', 'HEAD', '--', ARCHITECTURE_LAYOUT_FILE]),
  )
  if (!entry?.object) return { id: 'default', layout: ARCHITECTURE_DEFAULT_LAYOUT }
  const content = (await read([entry.object])).get(entry.object)
  if (content === undefined) throw new Error('Git did not return the layout file')
  return { id: entry.object, layout: parseArchitectureLayout(content) }
}
