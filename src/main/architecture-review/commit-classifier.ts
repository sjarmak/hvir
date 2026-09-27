import {
  ARCHITECTURE_CLASSIFY_LIMIT,
  ARCHITECTURE_SCOPE,
  type ArchitectureCaptureRequest,
  type ArchitectureCommitClassifyRequest,
  type ArchitectureCommitClassifyResult,
  type ArchitectureCommitChange,
} from '../../shared/architecture-review'
import type {
  ArchitectureAnalysis,
  ArchitectureSourceFile,
} from '../../shared/architecture-analysis'
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
  changeFromAnalysis,
  classifyCommitChange,
  COMMIT_CHANGE_CLASSIFIER_VERSION,
  configChanged,
  modifiedSources,
  parseCommitDiffs,
  structurallyChanged,
  type CommitDiff,
  type CommitDiffEntry,
  type ImportSignature,
} from './commit-change'
import { CommitChangeCache, type CommitChangeKey } from './commit-change-cache'
import { readArchitectureBlobs, readArchitectureBlobSizes } from './git-blobs'
import { architectureGitContext, validateArchitectureRoot } from './git-context'
import type { ModuleImportsResult } from './module-imports'

export type ModuleImportsPort = (
  sources: readonly ArchitectureSourceFile[],
  root: HostPath,
  signal: AbortSignal,
) => Promise<ModuleImportsResult>

export type PairScanPort = (
  host: ProjectHost,
  request: ArchitectureCaptureRequest,
  signal: AbortSignal,
) => Promise<ArchitectureAnalysis | undefined>

export interface ReadBudget {
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export interface ArchitectureCommitClassifierPorts {
  readonly imports: ModuleImportsPort
  readonly scan?: PairScanPort
  readonly cacheEntries?: number
  readonly budget?: ReadBudget
}

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_OUTPUT = 16 * 1024 * 1024
const MAX_MODULES_PER_COMMIT = 200
export const MAX_SCANS_PER_REQUEST = 4
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

type Context = ReturnType<typeof architectureGitContext>
type ImportTable = ReadonlyMap<string, readonly ImportSignature[] | null>

export class ArchitectureCommitClassifier {
  private readonly cache: CommitChangeCache
  private readonly budget: ReadBudget
  private scanners = COMMIT_CHANGE_CLASSIFIER_VERSION

  constructor(private readonly ports: ArchitectureCommitClassifierPorts) {
    this.cache = new CommitChangeCache(ports.cacheEntries ?? DEFAULT_CACHE_ENTRIES)
    this.budget = ports.budget ?? ARCHITECTURE_SCOPE
  }

  async classify(
    host: ProjectHost,
    request: ArchitectureCommitClassifyRequest,
    signal: AbortSignal,
  ): Promise<ArchitectureCommitClassifyResult> {
    validateArchitectureRoot(host, request.root)
    validateRevisions(request.revisions)
    const root = request.root
    const context = architectureGitContext(host, root, signal)
    const run = (args: readonly string[]) => context.run(root, args, MAX_OUTPUT)
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    if (!HASH.test(head)) throw new Error('Git did not name HEAD')
    if (request.revisions.length === 0) return { head, classifications: [] }
    const layout = await readHeadLayout(run, (objects) =>
      readArchitectureBlobs(context, root, objects),
    )
    const diffs = parseCommitDiffs(await run([...RAW_LOG, ...request.revisions, '--']))
    const byRevision = new Map(diffs.map((diff) => [diff.revision, diff]))
    const answers = new Map<string, ArchitectureCommitChange>()
    const scans: Pending[] = []
    const reads: Pending[] = []
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
      const pending = { diff, key, modified: modifiedSources(diff.entries, layout.layout) }
      const structural = this.decideWithoutReading(diff, layout.layout)
      if (structural) {
        this.cache.store({ ...key, scanners: COMMIT_CHANGE_CLASSIFIER_VERSION }, structural)
        answers.set(revision, structural)
      } else if (configChanged(diff.entries, layout.layout)) scans.push(pending)
      else reads.push(pending)
    }
    for (const [revision, change] of await this.scanAll(host, root, scans, signal))
      answers.set(revision, change)
    for (const [revision, change] of await this.readAll(root, context, reads, layout, signal))
      answers.set(revision, change)
    const classifications = request.revisions.map((revision) => {
      const diff = byRevision.get(revision)!
      return {
        revision,
        parent: diff.parents[0] ?? null,
        merge: diff.parents.length > 1,
        change: answers.get(revision)!,
      }
    })
    return { head, classifications }
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
    if (configChanged(diff.entries, layout)) return undefined
    const modified = modifiedSources(diff.entries, layout)
    if (modified.length === 0) return 'none'
    if (modified.length > MAX_MODULES_PER_COMMIT) return 'unclassified'
    return undefined
  }

  private async scanAll(
    host: ProjectHost,
    root: HostPath,
    pending: readonly Pending[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ArchitectureCommitChange>> {
    const answers = new Map<string, ArchitectureCommitChange>()
    let scans = 0
    for (const entry of pending) {
      const parent = entry.diff.parents[0]
      if (!this.ports.scan || parent === undefined || scans >= MAX_SCANS_PER_REQUEST) {
        answers.set(entry.diff.revision, 'unclassified')
        continue
      }
      scans += 1
      const analysis = await this.ports.scan(
        host,
        { root, baseline: parent, current: entry.diff.revision },
        signal,
      )
      if (!analysis) {
        answers.set(entry.diff.revision, 'unclassified')
        continue
      }
      const change = changeFromAnalysis(analysis, entry.modified.length)
      this.cache.store({ ...entry.key, scanners: COMMIT_CHANGE_CLASSIFIER_VERSION }, change)
      answers.set(entry.diff.revision, change)
    }
    return answers
  }

  private async readAll(
    root: HostPath,
    context: Context,
    pending: readonly Pending[],
    layout: { readonly layout: ArchitectureLayout },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ArchitectureCommitChange>> {
    const answers = new Map<string, ArchitectureCommitChange>()
    if (pending.length === 0) return answers
    const affordable = await this.withinBudget(root, context, pending)
    for (const entry of pending)
      if (!affordable.includes(entry)) answers.set(entry.diff.revision, 'unclassified')
    if (affordable.length === 0) return answers
    const table = await this.importsOf(affordable, root, context, signal)
    for (const entry of affordable) {
      const change = classifyCommitChange(entry.diff.entries, layout.layout, table)
      this.cache.store({ ...entry.key, scanners: this.scanners }, change)
      answers.set(entry.diff.revision, change)
    }
    return answers
  }

  private async withinBudget(
    root: HostPath,
    context: Context,
    pending: readonly Pending[],
  ): Promise<readonly Pending[]> {
    const objects = pending.flatMap((entry) =>
      entry.modified.flatMap((modified) => [modified.before, modified.after]),
    )
    const sizes = await readArchitectureBlobSizes(context, root, objects)
    const affordable: Pending[] = []
    const counted = new Set<string>()
    let total = 0
    for (const entry of pending) {
      const wanted = [
        ...new Set(entry.modified.flatMap((modified) => [modified.before, modified.after])),
      ]
      const sized = wanted.map((object) => sizes.get(object) ?? Number.POSITIVE_INFINITY)
      if (sized.some((size) => size > this.budget.maxFileBytes)) continue
      const added = wanted.reduce(
        (sum, object, index) => (counted.has(object) ? sum : sum + sized[index]!),
        0,
      )
      if (total + added > this.budget.maxTotalBytes) continue
      total += added
      for (const object of wanted) counted.add(object)
      affordable.push(entry)
    }
    return affordable
  }

  private async importsOf(
    pending: readonly Pending[],
    root: HostPath,
    context: Context,
    signal: AbortSignal,
  ): Promise<ImportTable> {
    const wanted = new Map<string, string>()
    for (const entry of pending)
      for (const modified of entry.modified) {
        wanted.set(modified.before, modified.path)
        wanted.set(modified.after, modified.path)
      }
    const contents = await readArchitectureBlobs(context, root, [...wanted.keys()])
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
