import { describe, expect, it } from 'vitest'

import { asHostId, hostPath, type ExternalAttentionSnapshot } from '../src/shared'
import type { Disposer } from '../src/main/project-host'
import {
  GasCityAttention,
  type CityAttentionWorkspaceTarget,
} from '../src/main/gascity/city-attention'
import type {
  CityEventStreamReason,
  HostCityEvents,
} from '../src/main/gascity/city-event-facts'
import type {
  SupervisorAccess,
  SupervisorAddressResult,
} from '../src/main/gascity/supervisor-access'
import type {
  GascitySupervisorClient,
  SupervisorResult,
} from '../src/main/gascity/supervisor-client'
import type {
  ListBodySessionResponse,
  SessionResponse,
} from '../src/main/gascity/generated-supervisor-api'

const RIG = asHostId('rig-1')
const OTHER = asHostId('rig-2')
const PROJECT = '/home/dev/hvir'
const FEATURE = '/home/dev/hvir-worktrees/wt-panel'

describe('gas city attention rollup', () => {
  it('raises the workspace a blocked worker is working in, with no view open', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    // Nothing observed Sessions here: the facts came from the host stream and
    // the open projects, which is the whole point (ADR-048).
    expect(world.published).toHaveLength(1)
    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 1 },
    ])
  })

  it('counts two interactions in one workspace as two', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1'), pending('w-2')])]
    world.sessions = [session('w-1', FEATURE), session('w-2', FEATURE)]
    world.attention.start()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 2 },
    ])
  })

  it('falls back to the project main workspace for a session outside every root', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', `${PROJECT}-scratch/tmp`)]
    world.attention.start()
    await world.settle()

    // Nothing contains that directory, so nothing is claimed about it.
    expect(world.attention.snapshot().entries).toEqual([])

    world.sessions = [session('w-1', `${PROJECT}/packages/app`)]
    world.hosts = [live([pending('w-2'), pending('w-1')])]
    world.notify()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-main', waiting: 1 },
    ])
  })

  it('places nothing for a host whose workspaces hvir does not hold', async () => {
    const world = harness()
    world.hosts = [{ ...live([pending('w-1')]), hostId: OTHER }]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([])
    // A host with no placement target is not worth a session read either.
    expect(world.reads).toBe(0)
  })

  it('reads the session list once and does not read again for the same pending set', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()
    world.notify()
    world.notify()
    await world.settle()

    expect(world.reads).toBe(1)
  })

  it('does not read again for a session the city has no record of', async () => {
    const world = harness()
    world.hosts = [live([pending('ghost')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    expect(world.reads).toBe(1)
    expect(world.attention.snapshot().entries).toEqual([])

    world.notify()
    await world.settle()
    expect(world.reads).toBe(1)
  })

  it('reads again when a pending session is one it has not seen', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    world.sessions = [session('w-1', FEATURE), session('w-2', PROJECT)]
    world.hosts = [live([pending('w-1'), pending('w-2')])]
    world.notify()
    await world.settle()

    expect(world.reads).toBe(2)
    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 1 },
      { workspaceId: 'ws-main', waiting: 1 },
    ])
  })

  it('clears the count when the interaction is answered, without another read', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()
    expect(world.reads).toBe(1)

    // Answering withdraws the interaction from the host's facts, which is a
    // notification, not a poll.
    world.hosts = [live([])]
    world.notify()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([])
    expect(world.reads).toBe(1)
  })

  it('marks the count stale with its reason when the host stream is lost', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    world.hosts = [lost([pending('w-1')], 'unreachable')]
    world.notify()
    await world.settle()

    // Kept, and not asserted: ADR-048 forbids both directions.
    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 1, stale: true, reason: 'unreachable' },
    ])
  })

  it('marks a stream that never opened with the reason it could not', async () => {
    const world = harness()
    world.hosts = [{ ...lost([pending('w-1')], 'city-unknown'), stream: 'unavailable' }]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 1, stale: true, reason: 'city-unknown' },
    ])
  })

  // Two hosts cannot normally place into one workspace, since a workspace lives
  // on exactly one host. The fold still must not average the two claims: a count
  // that is part unverified is unverified.
  it('keeps a workspace stale when any contribution to it is', async () => {
    const world = harness()
    world.workspaces = [
      ...world.workspaces,
      {
        workspaceId: 'ws-feature',
        root: hostPath(OTHER, FEATURE),
        projectRoot: hostPath(OTHER, PROJECT),
        projectKey: 'p-2',
        main: false,
      },
    ]
    world.hosts = [
      live([pending('w-1')]),
      { ...lost([pending('w-2')], 'timeout'), hostId: OTHER },
    ]
    world.sessions = [session('w-1', FEATURE), session('w-2', FEATURE)]
    world.attention.start()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 2, stale: true, reason: 'timeout' },
    ])
  })

  it('publishes only when the entries change, and numbers each publish', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()
    world.notify()
    await world.settle()

    expect(world.published.map((snapshot) => snapshot.revision)).toEqual([1])

    world.hosts = [live([])]
    world.notify()
    await world.settle()
    expect(world.published.map((snapshot) => snapshot.revision)).toEqual([1, 2])
  })

  it('keeps the count when a placement read fails', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    world.readFailure = 'timeout'
    world.hosts = [live([pending('w-1'), pending('w-9')])]
    world.notify()
    await world.settle()

    expect(world.attention.snapshot().entries).toEqual([
      { workspaceId: 'ws-feature', waiting: 1 },
    ])
  })

  it('never reads when the host cannot be addressed', async () => {
    const world = harness({
      address: () => ({ ok: false, failure: { reason: 'unreachable' } }),
    })
    world.hosts = [live([pending('w-1')])]
    world.attention.start()
    await world.settle()

    expect(world.reads).toBe(0)
    expect(world.attention.snapshot().entries).toEqual([])
  })

  it('forgets a host that is no longer followed, and reads again if it returns', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    world.hosts = []
    world.notify()
    await world.settle()
    expect(world.attention.snapshot().entries).toEqual([])

    world.hosts = [live([pending('w-1')])]
    world.notify()
    await world.settle()
    expect(world.reads).toBe(2)
  })

  it('stops publishing once disposed, and disposal is idempotent', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    world.attention.dispose()
    world.attention.dispose()
    expect(world.released).toBe(2)

    world.hosts = [live([])]
    world.notify()
    await world.settle()
    expect(world.published).toHaveLength(1)
  })
})

describe('gas city attention pending sessions', () => {
  it('lists each placed pending session with its workspace, kind and title', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1'), pending('ghost'), pending('w-2')])]
    world.sessions = [session('w-1', FEATURE), session('w-2', PROJECT)]
    world.attention.start()
    await world.settle()

    expect(world.attention.pendingSessions()).toEqual([
      {
        hostId: RIG,
        sessionKey: 'w-1',
        cityRoot: hostPath(RIG, '/home/dev/gas-city'),
        workspaceId: 'ws-feature',
        kind: 'approval',
        freshness: 'fresh',
        title: 'w-1',
      },
      {
        hostId: RIG,
        sessionKey: 'w-2',
        cityRoot: hostPath(RIG, '/home/dev/gas-city'),
        workspaceId: 'ws-main',
        kind: 'approval',
        freshness: 'fresh',
        title: 'w-2',
      },
    ])
  })

  it('marks a pending session stale with the reason its host stream went down', async () => {
    const world = harness()
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    world.hosts = [lost([pending('w-1')], 'unreachable')]
    world.notify()
    await world.settle()

    expect(world.attention.pendingSessions()).toMatchObject([
      { sessionKey: 'w-1', freshness: 'stale', reason: 'unreachable' },
    ])
  })

  it('notifies pending observers only when the pending sessions change', async () => {
    const world = harness()
    let notified = 0
    world.attention.observePending(() => {
      notified += 1
    })
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()
    world.notify()
    world.notify()
    await world.settle()
    expect(notified).toBe(1)

    world.hosts = [live([pending('w-1'), pending('w-1-b')])]
    world.sessions = [session('w-1', FEATURE), session('w-1-b', FEATURE)]
    world.notify()
    await world.settle()
    // The workspace count changed too, so both publications moved together.
    expect(notified).toBe(2)
    expect(world.published).toHaveLength(2)
  })

  it('notifies pending observers after the workspace snapshot is published, never inside it', async () => {
    const world = harness()
    const order: string[] = []
    world.onPublish = () => order.push('publish')
    world.attention.observePending(() => {
      order.push(`pending@${world.attention.snapshot().revision}`)
    })
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()

    expect(order).toEqual(['publish', 'pending@1'])
  })

  it('stops notifying a released pending observer and empties on dispose', async () => {
    const world = harness()
    let notified = 0
    const stop = world.attention.observePending(() => {
      notified += 1
    })
    world.hosts = [live([pending('w-1')])]
    world.sessions = [session('w-1', FEATURE)]
    world.attention.start()
    await world.settle()
    expect(notified).toBe(1)

    void stop()
    world.attention.dispose()
    expect(notified).toBe(1)
    expect(world.attention.pendingSessions()).toEqual([])
  })
})

function live(
  entries: readonly { sessionKey: string; requestId: string; kind: string }[],
) {
  return facts('live', entries)
}

function lost(
  entries: readonly { sessionKey: string; requestId: string; kind: string }[],
  reason: CityEventStreamReason,
): HostCityEvents {
  return { ...facts('lost', entries), reason }
}

function facts(
  stream: HostCityEvents['stream'],
  entries: readonly { sessionKey: string; requestId: string; kind: string }[],
): HostCityEvents {
  return {
    hostId: RIG,
    cityRoot: hostPath(RIG, '/home/dev/gas-city'),
    stream,
    observedAt: 1,
    lifecycle: [],
    pending: entries,
  }
}

function pending(sessionKey: string) {
  return { sessionKey, requestId: `req-${sessionKey}`, kind: 'approval' }
}

function session(id: string, workDir: string): SessionResponse {
  return {
    attached: false,
    created_at: '2026-09-17T00:00:00Z',
    id,
    provider: 'claude',
    running: true,
    session_name: id,
    state: 'running',
    template: 'worker',
    title: id,
    work_dir: workDir,
  }
}

function harness(overrides: { readonly address?: () => SupervisorAddressResult } = {}) {
  let listener: (() => void) | undefined

  const world = {
    hosts: [] as readonly HostCityEvents[],
    sessions: [] as readonly SessionResponse[],
    readFailure: undefined as 'timeout' | undefined,
    reads: 0,
    released: 0,
    published: [] as ExternalAttentionSnapshot[],
    onPublish: undefined as (() => void) | undefined,
    workspaces: [
      {
        workspaceId: 'ws-main',
        root: hostPath(RIG, PROJECT),
        projectRoot: hostPath(RIG, PROJECT),
        projectKey: 'p-1',
        main: true,
      },
      {
        workspaceId: 'ws-feature',
        root: hostPath(RIG, FEATURE),
        projectRoot: hostPath(RIG, PROJECT),
        projectKey: 'p-1',
        main: false,
      },
    ] as readonly CityAttentionWorkspaceTarget[],
    attention: undefined as unknown as GasCityAttention,
    notify: () => listener?.(),
    settle: async () => {
      for (let turn = 0; turn < 16; turn += 1) await Promise.resolve()
    },
  }

  const client = {
    sessions: (): Promise<SupervisorResult<ListBodySessionResponse>> => {
      world.reads += 1
      if (world.readFailure !== undefined)
        return Promise.resolve({
          ok: false,
          failure: { reason: world.readFailure, detail: '' },
        })
      return Promise.resolve({
        ok: true,
        value: { items: world.sessions, total: world.sessions.length },
      })
    },
  } as unknown as GascitySupervisorClient

  const access: SupervisorAccess = {
    address: () =>
      Promise.resolve(
        overrides.address?.() ?? { ok: true, value: { client, cityName: 'mem' } },
      ),
  }

  world.attention = new GasCityAttention({
    access,
    streams: {
      observationSnapshot: () => world.hosts,
      observe: (candidate) => {
        listener = candidate
        return release(world)
      },
    },
    workspaces: () => world.workspaces,
    observeWorkspaces: () => release(world),
    publish: (snapshot) => {
      world.published.push(snapshot)
      world.onPublish?.()
    },
  })
  return world
}

function release(world: { released: number }): Disposer {
  return () => {
    world.released += 1
  }
}
