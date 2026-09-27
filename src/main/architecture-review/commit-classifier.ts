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
import { isSource, parseTree, selectEntries, type CaptureEntry } from './capture-entries'
import {
  changeFromAnalysis,
  classifyCommitChange,
  COMMIT_CHANGE_CLASSIFIER_VERSION,
  configChanged,
  edgeKey,
  modifiedSources,
  parseCommitDiffs,
  structurallyChanged,
  type CommitDiff,
  type CommitDiffEntry,
  type EdgeTable,
} from './commit-change'
import { CommitChangeCache, type CommitChangeKey } from './commit-change-cache'
import { readArchitectureBlobs, readArchitectureBlobSizes } from './git-blobs'
import { architectureGitContext, validateArchitectureRoot } from './git-context'
import type {
  ModuleEdgesRequest,
  ModuleEdgesResult,
  ModuleSide,
  ModuleSource,
} from './module-edges'
import { assertWithinScopeCap } from './scope-cap'

export type ModuleImportsPort = (
  request: ModuleEdgesRequest,
  root: HostPath,
  signal: AbortSignal,
) => Promise<ModuleEdgesResult>

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

interface SideListing {
  readonly revision: string
  readonly modules: readonly string[]
  readonly configs: readonly CaptureEntry[]
}

interface Layout {
  readonly id: string
  readonly layout: ArchitectureLayout
}

type Context = ReturnType<typeof architectureGitContext>
type Run = (args: readonly string[]) => Promise<string>

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
      const pending = {
        diff,
        key,
        modified: modifiedSources(diff.entries, layout.layout),
      }
      const structural = this.decideWithoutReading(diff, layout.layout)
      if (structural) {
        this.remember({ ...key, scanners: COMMIT_CHANGE_CLASSIFIER_VERSION }, structural)
        answers.set(revision, structural)
      } else if (configChanged(diff.entries, layout.layout)) scans.push(pending)
      else reads.push(pending)
    }
    const budget = { scans: 0 }
    for (const [revision, change] of await this.scanAll(
      host,
      root,
      scans,
      budget,
      signal,
    ))
      answers.set(revision, change)
    const read = await this.readAll(root, context, run, reads, layout, signal)
    for (const [revision, change] of read.answers) answers.set(revision, change)
    for (const [revision, change] of await this.scanAll(
      host,
      root,
      read.needsScan,
      budget,
      signal,
    ))
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

  private remember(key: CommitChangeKey, change: ArchitectureCommitChange): void {
    if (change !== 'unclassified') this.cache.store(key, change)
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
    budget: { scans: number },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ArchitectureCommitChange>> {
    const answers = new Map<string, ArchitectureCommitChange>()
    for (const entry of pending) {
      const parent = entry.diff.parents[0]
      if (
        !this.ports.scan ||
        parent === undefined ||
        budget.scans >= MAX_SCANS_PER_REQUEST
      ) {
        answers.set(entry.diff.revision, 'unclassified')
        continue
      }
      budget.scans += 1
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
      this.remember({ ...entry.key, scanners: COMMIT_CHANGE_CLASSIFIER_VERSION }, change)
      answers.set(entry.diff.revision, change)
    }
    return answers
  }

  private async readAll(
    root: HostPath,
    context: Context,
    run: Run,
    pending: readonly Pending[],
    layout: Layout,
    signal: AbortSignal,
  ): Promise<{
    readonly answers: ReadonlyMap<string, ArchitectureCommitChange>
    readonly needsScan: readonly Pending[]
  }> {
    const answers = new Map<string, ArchitectureCommitChange>()
    const needsScan: Pending[] = []
    if (pending.length === 0) return { answers, needsScan }
    const sides = await this.listSides(run, pending, layout)
    const listed = pending.filter((entry) =>
      sidesOf(entry).every((revision) => sides.has(revision)),
    )
    for (const entry of pending)
      if (!listed.includes(entry)) answers.set(entry.diff.revision, 'unclassified')
    const affordable = await this.withinBudget(root, context, listed, sides)
    for (const entry of listed)
      if (!affordable.includes(entry)) answers.set(entry.diff.revision, 'unclassified')
    if (affordable.length === 0) return { answers, needsScan }
    const result = await this.edgesOf(affordable, sides, root, context, signal)
    const table: EdgeTable = new Map(
      result.edges.map((entry) => [edgeKey(entry.side, entry.object), entry.edges]),
    )
    const facts = new Set(
      result.edges.flatMap((entry) =>
        entry.needsFacts ? [edgeKey(entry.side, entry.object)] : [],
      ),
    )
    for (const entry of affordable) {
      if (
        entry.modified.some((modified) =>
          facts.has(edgeKey(entry.diff.revision, modified.after)),
        )
      ) {
        needsScan.push(entry)
        continue
      }
      const change = classifyCommitChange(entry.diff, layout.layout, table)
      this.remember({ ...entry.key, scanners: this.scanners }, change)
      answers.set(entry.diff.revision, change)
    }
    return { answers, needsScan }
  }

  private async listSides(
    run: Run,
    pending: readonly Pending[],
    layout: Layout,
  ): Promise<ReadonlyMap<string, SideListing>> {
    const sides = new Map<string, SideListing>()
    for (const revision of new Set(pending.flatMap(sidesOf))) {
      const listing = await run(['ls-tree', '-r', '-l', '-z', revision, '--', '.'])
      let selected: readonly CaptureEntry[]
      try {
        selected = selectEntries(parseTree(listing), layout.layout)
        assertWithinScopeCap(selected, { end: revision, scope: layout.layout.scope })
      } catch {
        continue
      }
      sides.set(revision, {
        revision,
        modules: selected.filter((entry) => isSource(entry.path)).map((e) => e.path),
        configs: selected.filter((entry) => !isSource(entry.path)),
      })
    }
    return sides
  }

  private async withinBudget(
    root: HostPath,
    context: Context,
    pending: readonly Pending[],
    sides: ReadonlyMap<string, SideListing>,
  ): Promise<readonly Pending[]> {
    const wantedOf = (entry: Pending) => [
      ...new Set([
        ...entry.modified.flatMap((modified) => [modified.before, modified.after]),
        ...sidesOf(entry).flatMap((revision) =>
          sides.get(revision)!.configs.map((config) => config.object!),
        ),
      ]),
    ]
    const sizes = await readArchitectureBlobSizes(
      context,
      root,
      pending.flatMap(wantedOf),
    )
    const affordable: Pending[] = []
    const counted = new Set<string>()
    let total = 0
    for (const entry of pending) {
      const wanted = wantedOf(entry)
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

  private async edgesOf(
    pending: readonly Pending[],
    sides: ReadonlyMap<string, SideListing>,
    root: HostPath,
    context: Context,
    signal: AbortSignal,
  ): Promise<ModuleEdgesResult> {
    const revisions = new Set(pending.flatMap(sidesOf))
    const wanted = new Map<string, string>()
    for (const revision of revisions)
      for (const config of sides.get(revision)!.configs)
        wanted.set(config.object!, config.path)
    for (const entry of pending)
      for (const modified of entry.modified) {
        wanted.set(modified.before, modified.path)
        wanted.set(modified.after, modified.path)
      }
    const contents = await readArchitectureBlobs(context, root, [...wanted.keys()])
    const file = (object: string, path: string): ArchitectureSourceFile => ({
      path,
      object,
      content: contents.get(object) ?? '',
    })
    const request: ModuleEdgesRequest = {
      sides: [...revisions].map((revision): ModuleSide => ({
        revision,
        modules: sides.get(revision)!.modules,
        configs: sides
          .get(revision)!
          .configs.map((config) => file(config.object!, config.path)),
      })),
      sources: pending.flatMap((entry) =>
        entry.modified.flatMap((modified): ModuleSource[] => [
          { ...file(modified.before, modified.path), side: entry.diff.parents[0]! },
          { ...file(modified.after, modified.path), side: entry.diff.revision },
        ]),
      ),
    }
    const result = await this.ports.imports(request, root, signal)
    this.scanners = result.scanners
    return result
  }
}

const sidesOf = (entry: Pending): readonly string[] => [
  entry.diff.parents[0]!,
  entry.diff.revision,
]

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
