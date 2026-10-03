import {
  NEEDS_YOU_PROJECTION_VERSION,
  type BeadsListResponse,
  type Disposer,
  type HostPath,
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
const READ_FAILURE_MESSAGE = 'Needs you source read failed'

export interface NeedsYouServiceDeps {
  readonly getProjectState: () => ProjectState
  readonly connectedHosts: () => readonly ProjectHost[]
  readonly beads: Pick<BeadsService, 'listForProject'>
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
  private observedCandidates?: {
    readonly sources: readonly NeedsYouSource[]
    readonly omittedSourceCount: number
  }

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
    this.assertCurrent(lease)
    const candidateRevision = this.candidateRevision
    const candidateSet = this.candidates()
    const candidates = candidateSet.sources
    const sources = await mapConcurrent(candidates, MAX_CONCURRENT_SOURCES, (candidate) =>
      this.readSourceIfCurrent(lease, candidateRevision, candidate),
    )
    this.assertCurrent(lease)
    if (candidateRevision !== this.candidateRevision)
      throw new NeedsYouLeaseExpiredError()
    lease.candidateRevision = candidateRevision
    lease.revision += 1
    return {
      version: NEEDS_YOU_PROJECTION_VERSION,
      demandGeneration: lease.demandGeneration,
      revision: lease.revision,
      observedAt: this.now(),
      sources,
      candidateLimit: MAX_SOURCES,
      omittedSourceCount: candidateSet.omittedSourceCount,
    }
  }

  private async readSourceIfCurrent(
    lease: Lease,
    candidateRevision: number,
    candidate: NeedsYouSource,
  ): Promise<NeedsYouSourceSnapshot> {
    this.assertCurrent(lease)
    if (candidateRevision !== this.candidateRevision)
      throw new NeedsYouLeaseExpiredError()
    return this.readSource(candidate)
  }

  private async readSource(source: NeedsYouSource): Promise<NeedsYouSourceSnapshot> {
    const beadsObservedAt = this.now()
    const pullsObservedAt = this.now()
    let project: { readonly host: ProjectHost; readonly root: HostPath }
    try {
      project = { host: this.host(source.hostId), root: source.root }
    } catch (reason) {
      const message = errorMessage(reason, READ_FAILURE_MESSAGE)
      return {
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
      }
    }
    const [beads, pulls] = await Promise.all([
      this.readBeads(source, project),
      this.readPulls(source, project),
    ])
    const boundedBeads = boundBeads(beads)
    const boundedPulls = boundPulls(pulls)
    return {
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
    }
  }

  private async readBeads(
    source: NeedsYouSource,
    project: { readonly host: ProjectHost; readonly root: HostPath },
  ): Promise<BeadsListResponse> {
    try {
      return await this.deps.beads.listForProject({ root: source.root }, project)
    } catch (reason) {
      return {
        available: false,
        reason: 'error',
        message: errorMessage(reason, READ_FAILURE_MESSAGE),
      }
    }
  }

  private async readPulls(
    source: NeedsYouSource,
    project: { readonly host: ProjectHost; readonly root: HostPath },
  ): Promise<PullsResponse> {
    try {
      return await this.deps.github.pullsForProject({ root: source.root }, project)
    } catch (reason) {
      return {
        available: false,
        reason: 'error',
        message: errorMessage(reason, READ_FAILURE_MESSAGE),
      }
    }
  }

  private candidates(): {
    readonly sources: readonly NeedsYouSource[]
    readonly omittedSourceCount: number
  } {
    const connected = new Map(
      this.deps.connectedHosts().map((host) => [host.hostId, host] as const),
    )
    const seen = new Set<string>()
    const sources: NeedsYouSource[] = []
    for (const project of this.deps.getProjectState().projects) {
      if (project.connectionState !== 'connected') continue
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
        !sameCandidates(previous.sources, current.sources) ||
        previous.omittedSourceCount !== current.omittedSourceCount
      ) {
        this.candidateRevision += 1
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

function sameCandidates(
  left: readonly NeedsYouSource[],
  right: readonly NeedsYouSource[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((candidate, index) => {
    const other = right[index]
    return (
      candidate.hostId === other?.hostId &&
      candidate.root.path === other.root.path &&
      candidate.projectId === other.projectId &&
      candidate.workspaceId === other.workspaceId
    )
  })
}

function boundBeads(response: BeadsListResponse): {
  readonly response: BeadsListResponse
  readonly truncated: boolean
} {
  if (!response.available) return { response, truncated: false }
  const issues = response.issues.slice(0, MAX_ITEMS_PER_SOURCE).map((issue) => ({
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
    truncated: response.issues.length > MAX_ITEMS_PER_SOURCE,
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
