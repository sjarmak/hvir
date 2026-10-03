import {
  NEEDS_YOU_PROJECTION_VERSION,
  beadNeedsHuman,
  hostPath,
  isOpenLabelledAsk,
  type BeadIssue,
  type BeadsListResponse,
  type Disposer,
  type HostPath,
  type NeedsYouAskStoreSnapshot,
  type NeedsYouDemandRequest,
  type NeedsYouSnapshot,
  type NeedsYouSource,
  type NeedsYouSourceSnapshot,
  type ProjectState,
  type PullsResponse,
} from '../../shared'
import type { BeadsService } from '../beads/beads-service'
import type { ProjectHost } from '../project-host'
import type { GitHubService } from '../github/github-service'
import {
  demandOwnerKey,
  type SessionsDemandOwner,
} from '../sessions/sessions-demand-owner'

const MAX_CONCURRENT_SOURCES = 4
const MAX_SOURCES = 128
const MAX_ITEMS_PER_SOURCE = 50
const MAX_READ_ATTEMPTS = 3
const READ_FAILURE_MESSAGE = 'Needs you source read failed'
const ASK_RIG_NAME = 'decisions'
const NO_ASKS: BeadsListResponse = {
  available: true,
  issues: [],
  readyIds: [],
  dispatchableIds: [],
  dispatchabilitySource: 'structural',
  dependencies: [],
  gates: [],
}

interface HostProject {
  readonly host: ProjectHost
  readonly root: HostPath
}

interface CityRig {
  readonly name: string
  readonly path: string
}

type StoreReads = Map<string, Promise<BeadsListResponse>>

interface SourceRead {
  readonly storeKey: string
  readonly snapshot: NeedsYouSourceSnapshot
}

interface AskStoreRead {
  readonly storeKey?: string
  readonly snapshot: NeedsYouAskStoreSnapshot
}

interface AskSource {
  readonly host: ProjectHost
  readonly roots: readonly HostPath[]
}

interface CandidateSet {
  readonly sources: readonly NeedsYouSource[]
  readonly askSources: readonly AskSource[]
  readonly omittedSourceCount: number
}

export interface NeedsYouServiceDeps {
  readonly getProjectState: () => ProjectState
  readonly connectedHosts: () => readonly ProjectHost[]
  readonly beads: Pick<BeadsService, 'listForProject' | 'storeForProject'>
  readonly cityRigs?: (project: HostProject) => Promise<readonly CityRig[] | undefined>
  readonly github: Pick<GitHubService, 'pullsForProject'>
  readonly observeCandidates?: (listener: () => void) => Disposer
  readonly onCandidatesChanged?: (candidateRevision: number) => void
  readonly now?: () => number
}

interface Lease {
  readonly owner: SessionsDemandOwner
  readonly demandGeneration: number
  candidateRevision: number
  revision: number
  active: boolean
  pending?: Promise<NeedsYouSnapshot>
}

export class NeedsYouLeaseExpiredError extends Error {
  constructor() {
    super('Needs you observation is no longer current')
    this.name = 'NeedsYouLeaseExpiredError'
  }
}

export class NeedsYouService {
  private readonly leases = new Map<string, Lease>()
  private readonly now: () => number
  private candidateRevision = 0
  private candidatesDisposer?: Disposer
  private observedCandidates?: CandidateSet

  constructor(private readonly deps: NeedsYouServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  acquire(
    owner: SessionsDemandOwner,
    request: NeedsYouDemandRequest,
  ): Promise<NeedsYouSnapshot> {
    const key = demandOwnerKey(owner)
    const existing = this.leases.get(key)
    if (existing !== undefined) {
      if (existing.demandGeneration !== request.demandGeneration) {
        throw new Error('Needs you observation is already active')
      }
      return this.read(existing)
    }
    const lease: Lease = {
      owner,
      demandGeneration: request.demandGeneration,
      candidateRevision: this.candidateRevision,
      revision: 0,
      active: true,
    }
    this.leases.set(key, lease)
    this.startCandidates()
    return this.read(lease)
  }

  snapshot(
    owner: SessionsDemandOwner,
    request: NeedsYouDemandRequest,
  ): Promise<NeedsYouSnapshot> {
    const lease = this.require(owner, request.demandGeneration)
    return this.read(lease)
  }

  release(owner: SessionsDemandOwner, demandGeneration: number): boolean {
    const key = demandOwnerKey(owner)
    const lease = this.leases.get(key)
    if (lease === undefined || lease.demandGeneration !== demandGeneration) return false
    lease.active = false
    this.leases.delete(key)
    if (this.leases.size === 0) this.stopCandidates()
    return true
  }

  private read(lease: Lease): Promise<NeedsYouSnapshot> {
    if (lease.pending !== undefined) return lease.pending
    const pending = this.readOnce(lease)
    lease.pending = pending
    void pending.then(
      () => {
        if (lease.pending === pending) lease.pending = undefined
      },
      () => {
        if (lease.pending === pending) lease.pending = undefined
      },
    )
    return pending
  }

  private async readOnce(lease: Lease): Promise<NeedsYouSnapshot> {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      const snapshot = await this.readCandidates(lease)
      if (snapshot !== undefined) return snapshot
    }
    throw new NeedsYouLeaseExpiredError()
  }

  private async readCandidates(lease: Lease): Promise<NeedsYouSnapshot | undefined> {
    this.assertCurrent(lease)
    const candidateRevision = this.candidateRevision
    const candidateSet = this.candidates()
    const stores: StoreReads = new Map()
    const [reads, askReads] = await Promise.all([
      mapConcurrent(candidateSet.sources, MAX_CONCURRENT_SOURCES, (candidate) => {
        this.assertCurrent(lease)
        return candidateRevision === this.candidateRevision
          ? this.readSource(candidate, stores)
          : Promise.resolve(undefined)
      }),
      this.readAskStores(candidateSet.askSources, stores),
    ])
    this.assertCurrent(lease)
    if (candidateRevision !== this.candidateRevision) return undefined
    lease.candidateRevision = candidateRevision
    lease.revision += 1
    return {
      version: NEEDS_YOU_PROJECTION_VERSION,
      demandGeneration: lease.demandGeneration,
      revision: lease.revision,
      observedAt: this.now(),
      sources: attributeStores(
        reads.filter((read) => read !== undefined),
        askReads,
      ),
      askStores: askReads
        .filter(
          (ask) =>
            !reads.some((read) => read !== undefined && read.storeKey === ask.storeKey),
        )
        .map((ask) => ask.snapshot),
      candidateLimit: MAX_SOURCES,
      omittedSourceCount: candidateSet.omittedSourceCount,
      candidateRevision,
    }
  }

  private async readSource(
    source: NeedsYouSource,
    stores: StoreReads,
  ): Promise<SourceRead> {
    const beadsObservedAt = this.now()
    const pullsObservedAt = this.now()
    let project: HostProject
    try {
      project = { host: this.host(source.hostId), root: source.root }
    } catch (reason) {
      const message = errorMessage(reason, READ_FAILURE_MESSAGE)
      return {
        storeKey: storeKey(source.root, undefined),
        snapshot: {
          ...source,
          beads: {
            response: { available: false, reason: 'error', message },
            observedAt: beadsObservedAt,
            itemLimit: MAX_ITEMS_PER_SOURCE,
            truncated: false,
          },
          pulls: {
            response: { available: false, reason: 'error', message },
            observedAt: pullsObservedAt,
            itemLimit: MAX_ITEMS_PER_SOURCE,
            truncated: false,
          },
        },
      }
    }
    const [store, pulls] = await Promise.all([
      this.readStore(project, stores),
      this.readPulls(source, project),
    ])
    const boundedBeads = boundBeads(store.response, beadNeedsHuman)
    const boundedPulls = boundPulls(pulls)
    return {
      storeKey: store.key,
      snapshot: {
        ...source,
        beads: {
          response: boundedBeads.response,
          observedAt: beadsObservedAt,
          itemLimit: MAX_ITEMS_PER_SOURCE,
          truncated: boundedBeads.truncated,
        },
        pulls: {
          response: boundedPulls.response,
          observedAt: pullsObservedAt,
          itemLimit: MAX_ITEMS_PER_SOURCE,
          truncated: boundedPulls.truncated,
        },
      },
    }
  }

  private async readStore(
    project: HostProject,
    stores: StoreReads,
  ): Promise<{ readonly key: string; readonly response: BeadsListResponse }> {
    let resolvedStore: string | undefined
    try {
      resolvedStore = await this.deps.beads.storeForProject(project, 'interactive')
    } catch (reason) {
      return {
        key: storeKey(project.root, undefined),
        response: {
          available: false,
          reason: 'error',
          message: errorMessage(reason, READ_FAILURE_MESSAGE),
        },
      }
    }
    const key = storeKey(project.root, resolvedStore)
    const pending = stores.get(key) ?? this.readBeads(project)
    stores.set(key, pending)
    return { key, response: await pending }
  }

  private async readBeads(project: HostProject): Promise<BeadsListResponse> {
    try {
      return await this.deps.beads.listForProject(
        { root: project.root, issuesOnly: true },
        project,
        'interactive',
      )
    } catch (reason) {
      return {
        available: false,
        reason: 'error',
        message: errorMessage(reason, READ_FAILURE_MESSAGE),
      }
    }
  }

  private async readAskStores(
    sources: readonly AskSource[],
    stores: StoreReads,
  ): Promise<readonly AskStoreRead[]> {
    const { cityRigs } = this.deps
    if (cityRigs === undefined) return []
    const reads = await Promise.all(
      sources.map((source) => this.readAskStore(source, cityRigs, stores)),
    )
    return reads.filter((read) => read !== undefined)
  }

  private async readAskStore(
    source: AskSource,
    cityRigs: NonNullable<NeedsYouServiceDeps['cityRigs']>,
    stores: StoreReads,
  ): Promise<AskStoreRead | undefined> {
    const observedAt = this.now()
    for (const root of source.roots) {
      let rigs: readonly CityRig[] | undefined
      try {
        rigs = await cityRigs({ host: source.host, root })
      } catch (reason) {
        return {
          snapshot: {
            name: ASK_RIG_NAME,
            root,
            beads: {
              response: {
                available: false,
                reason: 'error',
                message: `Gas City rig list unavailable: ${errorMessage(reason, READ_FAILURE_MESSAGE)}`,
              },
              observedAt,
              itemLimit: MAX_ITEMS_PER_SOURCE,
              truncated: false,
            },
          },
        }
      }
      if (rigs === undefined) continue
      const rig = rigs.find(
        (candidate) => candidate.name === ASK_RIG_NAME && candidate.path.startsWith('/'),
      )
      if (rig === undefined) return undefined
      const store = await this.readStore(
        { host: source.host, root: hostPath(source.host.hostId, rig.path) },
        stores,
      )
      const bounded = boundBeads(store.response, isOpenLabelledAsk)
      return {
        storeKey: store.key,
        snapshot: {
          name: rig.name,
          root: hostPath(source.host.hostId, rig.path),
          beads: {
            response: bounded.response,
            observedAt,
            itemLimit: MAX_ITEMS_PER_SOURCE,
            truncated: bounded.truncated,
          },
        },
      }
    }
    return undefined
  }

  private async readPulls(
    source: NeedsYouSource,
    project: HostProject,
  ): Promise<PullsResponse> {
    try {
      return await this.deps.github.pullsForProject(
        { root: source.root },
        project,
        'interactive',
      )
    } catch (reason) {
      return {
        available: false,
        reason: 'error',
        message: errorMessage(reason, READ_FAILURE_MESSAGE),
      }
    }
  }

  private candidates(): CandidateSet {
    const connected = new Map(
      this.deps.connectedHosts().map((host) => [host.hostId, host] as const),
    )
    const seen = new Set<string>()
    const sources: NeedsYouSource[] = []
    const rootsByHost = new Map<string, { host: ProjectHost; roots: HostPath[] }>()
    for (const project of this.deps.getProjectState().projects) {
      if (project.connectionState !== 'connected') continue
      const host = connected.get(project.registeredRoot.hostId)
      if (host !== undefined) {
        const held = rootsByHost.get(host.hostId)
        if (held === undefined) {
          rootsByHost.set(host.hostId, { host, roots: [project.registeredRoot] })
        } else if (
          !held.roots.some(
            (root) =>
              root.hostId === project.registeredRoot.hostId &&
              root.path === project.registeredRoot.path,
          )
        ) {
          rootsByHost.set(host.hostId, {
            host,
            roots: [...held.roots, project.registeredRoot],
          })
        }
      }
      for (const workspace of project.workspaces) {
        if (workspace.closed || workspace.missing) continue
        if (!connected.has(workspace.root.hostId)) continue
        const key = `${workspace.root.hostId}\u0000${workspace.root.path}`
        if (seen.has(key)) continue
        seen.add(key)
        sources.push({
          projectId: project.id,
          workspaceId: workspace.id,
          projectName: project.displayName,
          workspaceName: workspace.name,
          root: workspace.root,
          hostId: workspace.root.hostId,
        })
      }
    }
    const sorted = sources.sort((left, right) =>
      `${left.hostId}\u0000${left.root.path}`.localeCompare(
        `${right.hostId}\u0000${right.root.path}`,
      ),
    )
    return {
      sources: sorted.slice(0, MAX_SOURCES),
      askSources: [...rootsByHost.values()]
        .sort((left, right) => left.host.hostId.localeCompare(right.host.hostId))
        .map(({ host, roots }) => ({
          host,
          roots: [...roots].sort((left, right) => left.path.localeCompare(right.path)),
        })),
      omittedSourceCount: Math.max(0, sorted.length - MAX_SOURCES),
    }
  }

  private host(hostId: string): ProjectHost {
    const host = this.deps
      .connectedHosts()
      .find((candidate) => candidate.hostId === hostId)
    if (!host) throw new Error('Needs you host is no longer connected')
    return host
  }

  private require(owner: SessionsDemandOwner, demandGeneration: number): Lease {
    const lease = this.leases.get(demandOwnerKey(owner))
    if (lease === undefined || lease.demandGeneration !== demandGeneration) {
      throw new NeedsYouLeaseExpiredError()
    }
    this.assertCurrent(lease)
    return lease
  }

  private assertCurrent(lease: Lease): void {
    if (!lease.active || this.leases.get(demandOwnerKey(lease.owner)) !== lease) {
      throw new NeedsYouLeaseExpiredError()
    }
  }

  private startCandidates(): void {
    if (this.candidatesDisposer !== undefined) return
    this.observedCandidates = this.candidates()
    this.candidatesDisposer = this.deps.observeCandidates?.(() => {
      const previous = this.observedCandidates ?? this.candidates()
      const current = this.candidates()
      this.observedCandidates = current
      if (
        !sameCandidates(previous, current) ||
        previous.omittedSourceCount !== current.omittedSourceCount
      ) {
        this.candidateRevision += 1
        console.warn('[needs-you] workspace candidates changed', {
          candidateRevision: this.candidateRevision,
          added: rootsMissingFrom(current.sources, previous.sources),
          removed: rootsMissingFrom(previous.sources, current.sources),
        })
        this.deps.onCandidatesChanged?.(this.candidateRevision)
      }
    })
  }

  private stopCandidates(): void {
    const dispose = this.candidatesDisposer
    this.candidatesDisposer = undefined
    void dispose?.()
    this.observedCandidates = undefined
  }
}

function rootsMissingFrom(
  sources: readonly NeedsYouSource[],
  others: readonly NeedsYouSource[],
): readonly string[] {
  const known = new Set(others.map((source) => `${source.hostId}:${source.root.path}`))
  return sources
    .map((source) => `${source.hostId}:${source.root.path}`)
    .filter((root) => !known.has(root))
}

function sameCandidates(left: CandidateSet, right: CandidateSet): boolean {
  if (left.sources.length !== right.sources.length) return false
  if (left.askSources.length !== right.askSources.length) return false
  const sameWorkspaces = left.sources.every((candidate, index) => {
    const other = right.sources[index]
    return (
      candidate.hostId === other?.hostId &&
      candidate.root.path === other.root.path &&
      candidate.projectId === other.projectId &&
      candidate.workspaceId === other.workspaceId
    )
  })
  return (
    sameWorkspaces &&
    left.askSources.every((source, index) => {
      const other = right.askSources[index]
      return (
        source.host.hostId === other?.host.hostId &&
        source.roots.length === other.roots.length &&
        source.roots.every(
          (root, rootIndex) =>
            root.hostId === other.roots[rootIndex]?.hostId &&
            root.path === other.roots[rootIndex]?.path,
        )
      )
    })
  )
}

function storeKey(root: HostPath, storePath: string | undefined): string {
  return storePath === undefined
    ? `${root.hostId}\u0000root\u0000${root.path}`
    : `${root.hostId}\u0000store\u0000${storePath}`
}

function attributeStores(
  reads: readonly SourceRead[],
  askReads: readonly AskStoreRead[],
): readonly NeedsYouSourceSnapshot[] {
  const owners = new Map<string, SourceRead>()
  const asksByStore = new Map(
    askReads.flatMap((read) =>
      read.storeKey === undefined ? [] : [[read.storeKey, read.snapshot.beads] as const],
    ),
  )
  for (const read of reads) {
    const owner = owners.get(read.storeKey)
    const holdsStore = read.storeKey.endsWith(`\u0000${read.snapshot.root.path}/.beads`)
    if (owner === undefined || holdsStore) owners.set(read.storeKey, read)
  }
  return reads.map((read) =>
    owners.get(read.storeKey) === read
      ? {
          ...read.snapshot,
          beads: asksByStore.get(read.storeKey) ?? read.snapshot.beads,
        }
      : {
          ...read.snapshot,
          beads: { ...read.snapshot.beads, response: NO_ASKS, truncated: false },
        },
  )
}

function boundBeads(
  response: BeadsListResponse,
  needsYou: (issue: BeadIssue) => boolean,
): {
  readonly response: BeadsListResponse
  readonly truncated: boolean
} {
  if (!response.available) return { response, truncated: false }
  const asks = response.issues.filter(needsYou)
  const issues = asks.slice(0, MAX_ITEMS_PER_SOURCE).map((issue) => ({
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    issueType: issue.issueType,
    ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
    labels: issue.labels,
    ...(issue.metadata?.['gc.answered'] === undefined
      ? {}
      : { metadata: { 'gc.answered': issue.metadata['gc.answered'] } }),
    dependencyCount: 0,
    dependentCount: 0,
  }))
  return {
    response: {
      issues,
      available: true,
      readyIds: [],
      dispatchableIds: [],
      dispatchabilitySource: response.dispatchabilitySource,
      dependencies: [],
      gates: [],
    },
    truncated: asks.length > MAX_ITEMS_PER_SOURCE,
  }
}

function boundPulls(response: PullsResponse): {
  readonly response: PullsResponse
  readonly truncated: boolean
} {
  if (!response.available) return { response, truncated: false }
  const branchPulls = response.branchPulls.slice(0, MAX_ITEMS_PER_SOURCE)
  const authored = response.authored.slice(0, MAX_ITEMS_PER_SOURCE)
  const reviewRequested = response.reviewRequested.slice(0, MAX_ITEMS_PER_SOURCE)
  return {
    response: { ...response, branchPulls, authored, reviewRequested },
    truncated:
      response.branchPulls.length > MAX_ITEMS_PER_SOURCE ||
      response.authored.length > MAX_ITEMS_PER_SOURCE ||
      response.reviewRequested.length > MAX_ITEMS_PER_SOURCE,
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await operation(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message !== '' ? reason.message : fallback
}
