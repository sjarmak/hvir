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
import { parseRigListOutput } from '../src/main/gascity/gascity-parse'
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

  it('keeps connected workspaces when the project registered root host is disconnected', async () => {
    const localRoot = hostPath(asHostId('local'), '/work/one')
    const projectState = withRegisteredRoot(
      state([workspace('workspace-one', localRoot)]),
      hostPath(asHostId('remote'), '/registered/project'),
    )
    const service = serviceFor(
      projectState,
      () => () => undefined,
      () => Promise.resolve(beadsUnavailable),
    )

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(snapshot.sources.map((source) => source.root)).toEqual([localRoot])
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
        storeForProject: noStore,
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

  it('reads beads and pulls on the interactive exec lane', async () => {
    const listForProject = vi.fn(() => Promise.resolve(beadsUnavailable))
    const pullsForProject = vi.fn(() => Promise.resolve(pullsUnavailable))
    const storeForProject = vi.fn(noStore)
    const service = new NeedsYouService({
      getProjectState: () =>
        state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      connectedHosts: () => [host('local')],
      beads: { listForProject, storeForProject },
      github: { pullsForProject },
    })
    await service.acquire(owner, { demandGeneration: 1 })
    expect(listForProject).toHaveBeenCalledWith(
      expect.objectContaining({ issuesOnly: true }),
      expect.anything(),
      'interactive',
    )
    expect(pullsForProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'interactive',
    )
    expect(storeForProject).toHaveBeenCalledWith(expect.anything(), 'interactive')
  })

  it('reads a store shared by several worktrees once and reports its asks under the workspace that holds it', async () => {
    const listForProject = vi.fn(() =>
      Promise.resolve(available([issue('ask-1', { labels: ['needs-human'] })])),
    )
    const service = new NeedsYouService({
      getProjectState: () =>
        state([
          workspace('worktree-a', hostPath(asHostId('local'), '/trees/a')),
          workspace('main', hostPath(asHostId('local'), '/work/repo')),
          workspace('worktree-b', hostPath(asHostId('local'), '/work/repo-b')),
        ]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject,
        storeForProject: () => Promise.resolve('/work/repo/.beads'),
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
    })

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(listForProject).toHaveBeenCalledTimes(1)
    expect(
      snapshot.sources.map((source) => [
        source.root.path,
        issueIds(source.beads.response),
      ]),
    ).toEqual([
      ['/trees/a', []],
      ['/work/repo', ['ask-1']],
      ['/work/repo-b', []],
    ])
  })

  it('reports a shared store without a holding workspace once, under the first worktree', async () => {
    const service = new NeedsYouService({
      getProjectState: () =>
        state([
          workspace('worktree-a', hostPath(asHostId('local'), '/trees/a')),
          workspace('worktree-b', hostPath(asHostId('local'), '/trees/b')),
        ]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject: () => Promise.reject(new Error('Dolt down')),
        storeForProject: () => Promise.resolve('/home/.beads'),
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
    })

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(snapshot.sources.map((source) => source.beads.response.available)).toEqual([
      false,
      true,
    ])
  })

  it('keeps asks that sit beyond the item limit in a large store and truncates only asks', async () => {
    const filler = Array.from({ length: 200 }, (_, index) => issue(`work-${index}`))
    const asks = Array.from({ length: 51 }, (_, index) =>
      issue(`ask-${index}`, { labels: ['needs/stephanie'] }),
    )
    const answered = issue('answered', {
      labels: ['needs/stephanie'],
      metadata: { 'gc.answered': '2026-10-01' },
    })
    let issues: readonly BeadIssue[] = [...filler, answered, asks[0]!]
    const service = serviceFor(
      state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      () => () => undefined,
      () => Promise.resolve(available(issues)),
    )

    const first = await service.acquire(owner, { demandGeneration: 1 })
    expect(issueIds(first.sources[0]!.beads.response)).toEqual(['ask-0'])
    expect(first.sources[0]!.beads.truncated).toBe(false)

    issues = [...filler, ...asks]
    const second = await service.snapshot(owner, { demandGeneration: 1 })
    expect(issueIds(second.sources[0]!.beads.response)).toHaveLength(50)
    expect(second.sources[0]!.beads.truncated).toBe(true)
  })

  it('reads the decisions rig of a connected city and applies the open-asks rule to it', async () => {
    const reads: string[] = []
    const cityRigs = vi.fn(() =>
      Promise.resolve([
        { name: 'hq', path: '/city' },
        { name: 'decisions', path: '/city/decisions' },
      ]),
    )
    const service = new NeedsYouService({
      getProjectState: () =>
        state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject: (request) => {
          reads.push(request.root.path)
          return Promise.resolve(
            request.root.path === '/city/decisions'
              ? available([
                  issue('dec-open', { labels: ['needs/stephanie'] }),
                  issue('dec-answered', {
                    labels: ['needs/stephanie'],
                    metadata: { 'gc.answered': '2026-09-27' },
                  }),
                  issue('dec-internal', { issueType: 'decision' }),
                ])
              : beadsUnavailable,
          )
        },
        storeForProject: (project) =>
          Promise.resolve(
            project.root.path === '/city/decisions'
              ? '/city/decisions/.beads'
              : undefined,
          ),
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
      cityRigs,
    })

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(reads.sort()).toEqual(['/city/decisions', '/work/one'])
    expect(snapshot.askStores).toHaveLength(1)
    expect(snapshot.askStores?.[0]).toMatchObject({
      name: 'decisions',
      root: hostPath(asHostId('local'), '/city/decisions'),
    })
    expect(issueIds(snapshot.askStores![0]!.beads.response)).toEqual(['dec-open'])
  })

  it('does not list the decisions store separately when an open workspace already reads it', async () => {
    const broaderHumanWork = Array.from({ length: 50 }, (_, index) =>
      issue(`decision-${index}`, { issueType: 'decision' }),
    )
    const listForProject = vi.fn(() =>
      Promise.resolve(
        available([
          ...broaderHumanWork,
          issue('dec-open', { labels: ['needs/stephanie'] }),
          issue('dec-answered', {
            labels: ['needs/stephanie'],
            metadata: { 'gc.answered': '2026-10-02' },
          }),
          issue('needs-human', { labels: ['needs-human'] }),
        ]),
      ),
    )
    const service = new NeedsYouService({
      getProjectState: () =>
        state([
          workspace('workspace-one', hostPath(asHostId('local'), '/city/decisions')),
        ]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject,
        storeForProject: () => Promise.resolve('/city/decisions/.beads'),
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
      cityRigs: () => Promise.resolve([{ name: 'decisions', path: '/city/decisions' }]),
    })

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(listForProject).toHaveBeenCalledTimes(1)
    expect(snapshot.askStores).toEqual([])
    expect(issueIds(snapshot.sources[0]!.beads.response)).toEqual(['dec-open'])
    expect(snapshot.sources[0]!.beads.truncated).toBe(false)
  })

  it('reports store-resolution failures as source problems without reading per root', async () => {
    const listForProject = vi.fn(() => Promise.resolve(available([])))
    const service = new NeedsYouService({
      getProjectState: () =>
        state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject,
        storeForProject: () => Promise.reject(new Error('bd where timed out')),
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
    })

    const snapshot = await service.acquire(owner, { demandGeneration: 1 })

    expect(listForProject).not.toHaveBeenCalled()
    expect(snapshot.sources[0]!.beads.response).toEqual({
      available: false,
      reason: 'error',
      message: 'bd where timed out',
    })
  })

  it('invalidates decisions reads when their registered project roots change', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let notifyCandidates!: () => void
    let resolveRigs!: (rigs: readonly { name: string; path: string }[]) => void
    const pendingRigs = new Promise<readonly { name: string; path: string }[]>(
      (resolve) => {
        resolveRigs = resolve
      },
    )
    const changed = vi.fn()
    const rigRoots: string[] = []
    const workspaceRoot = hostPath(asHostId('local'), '/work/one')
    let currentState = withRegisteredRoot(
      state([workspace('workspace-one', workspaceRoot)]),
      hostPath(asHostId('local'), '/city/one'),
    )
    const service = new NeedsYouService({
      getProjectState: () => currentState,
      connectedHosts: () => [host('local')],
      observeCandidates: (listener) => {
        notifyCandidates = listener
        return () => undefined
      },
      onCandidatesChanged: changed,
      beads: {
        listForProject: () => Promise.resolve(beadsUnavailable),
        storeForProject: noStore,
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
      cityRigs: ({ root }) => {
        rigRoots.push(root.path)
        return rigRoots.length === 1
          ? pendingRigs
          : Promise.resolve([{ name: 'decisions', path: `${root.path}/decisions` }])
      },
    })
    const reading = service.acquire(owner, { demandGeneration: 1 })

    currentState = withRegisteredRoot(
      state([workspace('workspace-one', workspaceRoot)]),
      hostPath(asHostId('local'), '/city/two'),
    )
    notifyCandidates()
    resolveRigs([{ name: 'decisions', path: '/city/one/decisions' }])

    const snapshot = await reading

    expect(changed).toHaveBeenCalledWith(1)
    expect(rigRoots).toEqual(['/city/one', '/city/two'])
    expect(snapshot.candidateRevision).toBe(1)
    expect(snapshot.askStores?.map((store) => store.root.path)).toEqual([
      '/city/two/decisions',
    ])
    expect(warned).toHaveBeenCalledWith(
      '[needs-you] workspace candidates changed',
      expect.objectContaining({ candidateRevision: 1 }),
    )
  })

  it('reports an unreadable rig list as an unavailable decisions store and skips hosts outside a city', async () => {
    const outside = new NeedsYouService({
      getProjectState: () =>
        state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject: () => Promise.resolve(beadsUnavailable),
        storeForProject: noStore,
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
      cityRigs: () => Promise.resolve(undefined),
    })
    expect((await outside.acquire(owner, { demandGeneration: 1 })).askStores).toEqual([])

    const failing = new NeedsYouService({
      getProjectState: () =>
        state([workspace('workspace-one', hostPath(asHostId('local'), '/work/one'))]),
      connectedHosts: () => [host('local')],
      beads: {
        listForProject: () => Promise.resolve(beadsUnavailable),
        storeForProject: noStore,
      },
      github: { pullsForProject: vi.fn(() => Promise.resolve(pullsUnavailable)) },
      cityRigs: () => Promise.resolve().then(() => parseRigListOutput('gc: not JSON')),
    })
    const snapshot = await failing.acquire(owner, { demandGeneration: 1 })
    expect(snapshot.askStores?.[0]?.beads.response).toEqual({
      available: false,
      reason: 'error',
      message:
        'Gas City rig list unavailable: gc rig list returned output that is not JSON',
    })
  })
})

const noStore = (): Promise<string | undefined> => Promise.resolve(undefined)

function issue(id: string, extra: Partial<BeadIssue> = {}): BeadIssue {
  return {
    id,
    title: id,
    status: 'open',
    priority: 2,
    issueType: 'task',
    labels: [],
    dependencyCount: 0,
    dependentCount: 0,
    ...extra,
  }
}

function available(issues: readonly BeadIssue[]): BeadsListResponse {
  return {
    available: true,
    issues,
    readyIds: [],
    dispatchableIds: [],
    dispatchabilitySource: 'structural',
    dependencies: [],
    gates: [],
  }
}

function issueIds(response: BeadsListResponse): readonly string[] {
  return response.available ? response.issues.map((entry) => entry.id) : []
}

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
      storeForProject: noStore,
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

function withRegisteredRoot(
  projectState: ProjectState,
  registeredRoot: HostPath,
): ProjectState {
  return {
    ...projectState,
    projects: projectState.projects.map((project) => ({ ...project, registeredRoot })),
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
