import { describe, expect, it, vi } from 'vitest'

import {
  asHostId,
  asSessionsWorkspaceHandle,
  hostPath,
  type BeadIssue,
  type BeadsListRequest,
  type BeadsListResponse,
  type HostPath,
  type ProjectState,
  type PullsResponse,
} from '../src/shared'
import {
  NeedsYouLeaseExpiredError,
  NeedsYouService,
} from '../src/main/needs-you/needs-you-service'
import type { SessionsDemandOwner } from '../src/main/sessions/sessions-demand-owner'
import type { ProjectHost } from '../src/main/project-host'
import type { Disposer } from '../src/shared'

const owner: SessionsDemandOwner = { kind: 'renderer', id: 7, generation: 1 }
const beadsUnavailable: BeadsListResponse = {
  available: false,
  reason: 'no-database',
  message: 'No database',
}
const pullsUnavailable: PullsResponse = {
  available: false,
  reason: 'no-github-repo',
  message: 'No repository',
}

describe('NeedsYouService', () => {
  it('reads only connected, open, nonmissing registered workspace roots once per host path', async () => {
    const root = hostPath(asHostId('local'), '/work/one')
    const second = hostPath(asHostId('local'), '/work/two')
    const reads: string[] = []
    const requests: BeadsListRequest[] = []
    const service = serviceFor(
      state([
        workspace('workspace-one', root),
        workspace('workspace-one-duplicate', root),
        workspace('workspace-two', second),
        workspace('closed', hostPath(asHostId('local'), '/work/closed'), true),
        workspace('missing', hostPath(asHostId('local'), '/work/missing'), false, true),
      ]),
      () => () => {},
      (request) => {
        reads.push(request.root.path)
        requests.push(request)
        return Promise.resolve(beadsUnavailable)
      },
    )

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(snapshot.sources.map((source) => source.root.path)).toEqual([
      '/work/one',
      '/work/two',
    ])
    expect(reads).toEqual(['/work/one', '/work/two'])
    expect(requests.every((request) => request.issuesOnly === true)).toBe(true)
    expect(
      snapshot.sources.every((source) => source.pulls.response.available === false),
    ).toBe(true)
  })

  it('releases an owner and rejects a late read instead of publishing it', async () => {
    let resolveBeads!: (response: BeadsListResponse) => void
    const pending = new Promise<BeadsListResponse>((resolve) => {
      resolveBeads = resolve
    })
    const currentState = state([
      workspace('workspace-one', hostPath(asHostId('local'), '/work/one')),
    ])
    const service = serviceFor(
      () => currentState,
      () => () => {},
      () => pending,
    )

    const reading = service.acquire(owner, { demandGeneration: 2 })
    expect(service.release(owner, 2)).toBe(true)
    resolveBeads(beadsUnavailable)

    await expect(reading).rejects.toBeInstanceOf(NeedsYouLeaseExpiredError)
  })

  it('rereads against the new candidate set when candidates change mid-read', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let notifyCandidates!: () => void
    let resolveBeads!: (response: BeadsListResponse) => void
    const pending = new Promise<BeadsListResponse>((resolve) => {
      resolveBeads = resolve
    })
    let currentState = state([
      workspace('workspace-one', hostPath(asHostId('local'), '/work/one')),
    ])
    const service = serviceFor(
      () => currentState,
      (listener) => {
        notifyCandidates = listener
        return () => undefined
      },
      () => pending,
    )

    const reading = service.acquire(owner, { demandGeneration: 3 })
    currentState = state([
      workspace('workspace-one', hostPath(asHostId('local'), '/work/one')),
      workspace('workspace-two', hostPath(asHostId('local'), '/work/two')),
    ])
    notifyCandidates()
    resolveBeads(beadsUnavailable)

    const snapshot = await reading
    expect(snapshot.sources.map((source) => source.root.path)).toEqual([
      '/work/one',
      '/work/two',
    ])
    expect(snapshot.candidateRevision).toBe(1)
    expect(warned).toHaveBeenCalledWith('[needs-you] workspace candidates changed', {
      candidateRevision: 1,
      added: ['local:/work/two'],
      removed: [],
    })
  })

  it('expires the read when candidates keep changing on every attempt', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let notifyCandidates!: () => void
    let reads = 0
    let currentState = state([
      workspace('workspace-0', hostPath(asHostId('local'), '/work/0')),
    ])
    const service = serviceFor(
      () => currentState,
      (listener) => {
        notifyCandidates = listener
        return () => undefined
      },
      () => {
        reads += 1
        currentState = state([
          workspace(`workspace-${reads}`, hostPath(asHostId('local'), `/work/${reads}`)),
        ])
        notifyCandidates()
        return Promise.resolve(beadsUnavailable)
      },
    )

    await expect(service.acquire(owner, { demandGeneration: 3 })).rejects.toBeInstanceOf(
      NeedsYouLeaseExpiredError,
    )
    expect(reads).toBe(3)
    expect(warned).toHaveBeenCalledTimes(3)
  })

  it('does not start queued source reads after release', async () => {
    let resolveRead!: (response: BeadsListResponse) => void
    const pending = new Promise<BeadsListResponse>((resolve) => {
      resolveRead = resolve
    })
    let reads = 0
    const service = serviceFor(
      state(
        Array.from({ length: 5 }, (_, index) =>
          workspace(`workspace-${index}`, hostPath(asHostId('local'), `/work/${index}`)),
        ),
      ),
      () => () => {},
      async () => {
        reads += 1
        return pending
      },
    )
    const reading = service.acquire(owner, { demandGeneration: 4 })
    await vi.waitFor(() => expect(reads).toBe(4))
    expect(service.release(owner, 4)).toBe(true)
    resolveRead(beadsUnavailable)
    await expect(reading).rejects.toBeInstanceOf(NeedsYouLeaseExpiredError)
    expect(reads).toBe(4)
  })

  it('emits topology changes only after the candidate set changes and strips queue payloads', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let notifyCandidates!: () => void
    let currentState = state([
      workspace('workspace-one', hostPath(asHostId('local'), '/work/one')),
    ])
    const changed = vi.fn()
    const service = new NeedsYouService({
      getProjectState: () => currentState,
      connectedHosts: () => [host('local')],
      observeCandidates: (listener) => {
        notifyCandidates = listener
        return () => undefined
      },
      onCandidatesChanged: changed,
      beads: {
        listForProject: vi.fn(() =>
          Promise.resolve({
            available: true as const,
            issues: [
              {
                id: 'dec-1',
                title: 'Choose a path',
                status: 'open',
                priority: 1,
                issueType: 'decision',
                labels: [
                  ...Array.from({ length: 40 }, (_, index) => `label-${index}`),
                  'needs-human',
                ],
                description: 'secret body',
                design: 'secret design',
                acceptanceCriteria: 'secret acceptance',
                notes: 'secret notes',
                metadata: { 'gc.answered': '' },
                dependencyCount: 99,
                dependentCount: 99,
              },
            ],
            readyIds: ['dec-1'],
            dispatchableIds: ['dec-1'],
            dispatchabilitySource: 'predicate' as const,
            dependencies: [{ blockerId: 'a', blockedId: 'b' }],
            gates: [{ id: 'gate', title: 'Gate', gateType: 'human', state: 'open' }],
          }),
        ),
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
    })
    const snapshot = await service.acquire(owner, { demandGeneration: 5 })
    expect(snapshot.sources[0]?.beads.response).toMatchObject({
      available: true,
      issues: [
        {
          id: 'dec-1',
          title: 'Choose a path',
          status: 'open',
          issueType: 'decision',
          metadata: { 'gc.answered': '' },
        },
      ],
      readyIds: [],
      dispatchableIds: [],
      dependencies: [],
      gates: [],
    })
    const projectedIssue: BeadIssue | undefined = snapshot.sources[0]?.beads.response
      .available
      ? snapshot.sources[0].beads.response.issues[0]
      : undefined
    expect(projectedIssue?.labels[projectedIssue.labels.length - 1]).toBe('needs-human')
    expect(snapshot.sources[0]?.beads.response).not.toHaveProperty('closedIssues')
    notifyCandidates()
    expect(changed).not.toHaveBeenCalled()
    currentState = state([
      workspace('workspace-one', hostPath(asHostId('local'), '/work/one')),
      workspace('workspace-two', hostPath(asHostId('local'), '/work/two')),
    ])
    notifyCandidates()
    expect(changed).toHaveBeenCalledWith(1)
    expect(warned).toHaveBeenCalledOnce()
    service.release(owner, 5)
  })

  it('coalesces repeated acquire calls for the same demand generation', async () => {
    let resolveBeads!: (response: BeadsListResponse) => void
    const pending = new Promise<BeadsListResponse>((resolve) => {
      resolveBeads = resolve
    })
    const service = serviceFor(
      state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      () => () => {},
      () => pending,
    )
    const first = service.acquire(owner, { demandGeneration: 6 })
    const second = service.acquire(owner, { demandGeneration: 6 })
    expect(second).toBe(first)
    resolveBeads(beadsUnavailable)
    await expect(second).resolves.toMatchObject({ demandGeneration: 6 })
    service.release(owner, 6)
  })

  it('bounds large candidate sets and reports omitted workspaces', async () => {
    const reads = vi.fn(() => Promise.resolve(beadsUnavailable))
    const service = serviceFor(
      state(
        Array.from({ length: 130 }, (_, index) =>
          workspace(`workspace-${index}`, hostPath(asHostId('local'), `/work/${index}`)),
        ),
      ),
      () => () => undefined,
      reads,
    )
    const snapshot = await service.acquire(owner, { demandGeneration: 7 })
    expect(snapshot.sources).toHaveLength(128)
    expect(snapshot.omittedSourceCount).toBe(2)
    expect(reads).toHaveBeenCalledTimes(128)
    service.release(owner, 7)
  })

  it('isolates source failures and rejects missing or mismatched leases', async () => {
    const service = serviceFor(
      state([workspace('one', hostPath(asHostId('local'), '/repo'))]),
      () => () => undefined,
      () => Promise.reject(new Error('Beads unavailable')),
    )
    expect(() => service.snapshot(owner, { demandGeneration: 1 })).toThrow(
      NeedsYouLeaseExpiredError,
    )
    const snapshot = await service.acquire(owner, { demandGeneration: 8 })
    expect(snapshot.sources[0]?.beads.response).toEqual({
      available: false,
      reason: 'error',
      message: 'Beads unavailable',
    })
    expect(snapshot.sources[0]?.pulls.response).toEqual(pullsUnavailable)
    expect(() => service.acquire(owner, { demandGeneration: 9 })).toThrow(
      'already active',
    )
    expect(service.release(owner, 9)).toBe(false)
    await expect(service.snapshot(owner, { demandGeneration: 8 })).resolves.toMatchObject(
      { revision: 2 },
    )
    expect(service.release(owner, 8)).toBe(true)
    expect(service.release(owner, 8)).toBe(false)
  })

  it('excludes disconnected projects and unconnected hosts without starting reads', async () => {
    const reads = vi.fn(() => Promise.resolve(beadsUnavailable))
    const disconnected = state([workspace('one', hostPath(asHostId('local'), '/repo'))])
    const projectState = {
      ...disconnected,
      projects: disconnected.projects.map((project) => ({
        ...project,
        connectionState: 'disconnected' as const,
      })),
    }
    const service = serviceFor(projectState, () => () => undefined, reads)
    expect((await service.acquire(owner, { demandGeneration: 1 })).sources).toEqual([])
    service.release(owner, 1)
    const remote = serviceFor(
      state([workspace('two', hostPath(asHostId('ssh-host'), '/repo'))]),
      () => () => undefined,
      reads,
    )
    expect((await remote.acquire(owner, { demandGeneration: 1 })).sources).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    remote.release(owner, 1)
  })
})

function serviceFor(
  projectState: ProjectState | (() => ProjectState),
  observeCandidates: (listener: () => void) => Disposer,
  readBeads: (request: BeadsListRequest) => Promise<BeadsListResponse>,
): NeedsYouService {
  return new NeedsYouService({
    getProjectState:
      typeof projectState === 'function' ? projectState : () => projectState,
    connectedHosts: () => [host('local')],
    observeCandidates,
    beads: {
      listForProject: vi.fn((request: BeadsListRequest) => readBeads(request)),
    },
    github: {
      pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)),
    },
    now: () => 100,
  })
}

function host(id: string): ProjectHost {
  return { hostId: asHostId(id), connectionState: 'connected' } as ProjectHost
}

function state(
  workspaces: ReadonlyArray<ProjectState['projects'][number]['workspaces'][number]>,
): ProjectState {
  return {
    revision: 1,
    root: workspaces[0]!.root,
    connectionState: 'connected',
    watchTier: 'polling',
    projects: [
      {
        id: 'project-one',
        registeredRoot: workspaces[0]!.root,
        displayName: 'Project One',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: workspaces[0]!.id,
        workspaces,
      },
    ],
    activeProjectId: 'project-one',
    activeWorkspaceId: workspaces[0]!.id,
  }
}

function workspace(
  id: string,
  root: HostPath,
  closed = false,
  missing = false,
): ProjectState['projects'][number]['workspaces'][number] {
  return {
    id: asSessionsWorkspaceHandle(id),
    root,
    name: id,
    head: undefined,
    branch: undefined,
    main: id === 'workspace-one',
    closed,
    missing,
    repository: true,
    changedFiles: 0,
  }
}
