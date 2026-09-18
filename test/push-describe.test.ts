import { describe, expect, it } from 'vitest'

import type { MainActionableEntry } from '../src/main/attention/actionable-attention-set'
import { createPushDescriber, PUSH_LINE_MAX } from '../src/main/companion/push-describe'
import type { ExternalPendingSession } from '../src/main/gascity/city-attention'
import type { SessionPendingResponse } from '../src/main/gascity/generated-supervisor-api'
import type {
  SupervisorAccess,
  SupervisorAddressResult,
} from '../src/main/gascity/supervisor-access'
import type {
  GascitySupervisorClient,
  SupervisorResult,
} from '../src/main/gascity/supervisor-client'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  asSessionsTerminalHandle,
  hostPath,
  type ProjectState,
} from '../src/shared'

const LOCAL = asHostId('local')
const RIG = asHostId('rig-1')
const PROJECT_ROOT = '/home/ds/secret-project'
const WORKSPACE_ROOT = '/home/ds/secret-project-worktrees/wt-panel'
const CITY_ROOT = '/home/ds/gas-city'
const HARNESS_SESSION_ID = 'harness-session-7f3a'
const SESSION_KEY = 'gc-session-9b2c'
const REQUEST_ID = 'req-4d1e'
const ATTACH_TARGET = 'gc attach --session gc-session-9b2c'

function terminalSession(extra: Partial<OwnedTerminalSession> = {}): OwnedTerminalSession {
  return {
    id: 't-1',
    providerId: asHarnessProviderId('provider-a'),
    profileId: asHarnessProfileId('profile-a'),
    launchRevision: 1,
    recoverySkipCount: 0,
    harnessSessionId: HARNESS_SESSION_ID,
    hostId: LOCAL,
    workspaceRoot: hostPath(LOCAL, WORKSPACE_ROOT),
    cwd: hostPath(LOCAL, `${WORKSPACE_ROOT}/packages/app`),
    title: 'Fix the panel',
    position: 0,
    active: true,
    updatedAt: 1,
    ...extra,
  }
}

function projectState(): ProjectState {
  return {
    root: hostPath(LOCAL, PROJECT_ROOT),
    revision: 3,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'p-1',
    activeWorkspaceId: 'ws-main',
    projects: [
      {
        id: 'p-1',
        registeredRoot: hostPath(LOCAL, PROJECT_ROOT),
        displayName: 'Secret Project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'ws-main',
        workspaces: [
          {
            id: 'ws-main',
            root: hostPath(LOCAL, PROJECT_ROOT),
            name: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'ws-panel',
            root: hostPath(LOCAL, WORKSPACE_ROOT),
            name: 'wt-panel',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 2,
          },
        ],
      },
    ],
  }
}

function terminalEntry(id = 't-1'): MainActionableEntry {
  return {
    key: id,
    kind: 'ready',
    freshness: 'fresh',
    terminalHandle: asSessionsTerminalHandle(id),
  }
}

function externalEntry(key = SESSION_KEY): MainActionableEntry {
  return {
    key: `gas-city ${RIG} ${key}`,
    kind: 'ready',
    freshness: 'fresh',
    external: { sourceId: 'gas-city', hostId: RIG, key },
  }
}

function pendingSession(extra: Partial<ExternalPendingSession> = {}): ExternalPendingSession {
  return {
    hostId: RIG,
    sessionKey: SESSION_KEY,
    cityRoot: hostPath(RIG, CITY_ROOT),
    workspaceId: 'ws-panel',
    kind: 'approval',
    freshness: 'fresh',
    title: 'Worker polecat',
    ...extra,
  }
}

interface HarnessOptions {
  readonly sessions?: readonly OwnedTerminalSession[]
  readonly pending?: readonly ExternalPendingSession[]
  readonly address?: SupervisorAddressResult
  readonly sessionPending?: () => Promise<SupervisorResult<SessionPendingResponse>>
}

function harness(options: HarnessOptions = {}) {
  const sessions = new Map((options.sessions ?? [terminalSession()]).map((s) => [s.id, s]))
  const pendingReads: { city: string; session: string }[] = []
  const client = {
    sessionPending: (city: string, session: string) => {
      pendingReads.push({ city, session })
      return (
        options.sessionPending?.() ??
        Promise.resolve({
          ok: true as const,
          value: {
            supported: true,
            pending: {
              kind: 'approval',
              request_id: REQUEST_ID,
              prompt: 'Allow the worker to edit src/panel.ts?\nSecond line stays home.',
              options: ['allow', 'deny'],
              metadata: { attach: ATTACH_TARGET },
            },
          },
        })
      )
    },
  } as unknown as GascitySupervisorClient
  const addressed: { hostId: string; cityRoot: string | undefined }[] = []
  const supervisor: SupervisorAccess = {
    address: (target) => {
      addressed.push({ hostId: target.hostId, cityRoot: target.cityRoot?.path })
      return Promise.resolve(
        options.address ?? { ok: true, value: { client, cityName: 'gastown' } },
      )
    },
  }
  const describe = createPushDescriber({
    terminals: { get: (id) => sessions.get(id) },
    projects: { state: projectState },
    supervisor,
    external: { pendingSessions: () => options.pending ?? [pendingSession()] },
  })
  return { describe, pendingReads, addressed }
}

function sweep(value: unknown): string {
  return JSON.stringify(value)
}

const PRIVATE_VALUES = [
  SESSION_KEY,
  REQUEST_ID,
  HARNESS_SESSION_ID,
  ATTACH_TARGET,
  PROJECT_ROOT,
  WORKSPACE_ROOT,
  CITY_ROOT,
  'allow',
  'deny',
  'sessionKey',
  'requestId',
  'request_id',
  'harnessSessionId',
  'attachTarget',
]

describe('push-describe', () => {
  it('describes a terminal entry from the registry and the project catalog', async () => {
    const { describe: describeEntry } = harness()

    const message = await describeEntry(terminalEntry())

    expect(message).toEqual({ project: 'Secret Project', title: 'Fix the panel', kind: 'ready' })
    for (const privateValue of PRIVATE_VALUES) expect(sweep(message)).not.toContain(privateValue)
  })

  it('carries the entry kind, not the terminal state', async () => {
    const { describe: describeEntry } = harness()

    const message = await describeEntry({ ...terminalEntry(), kind: 'bell' })

    expect(message?.kind).toBe('bell')
  })

  it('scrubs a terminal title that repeats a private value, like the projection does', async () => {
    const { describe: describeEntry } = harness({
      sessions: [terminalSession({ title: `resume ${HARNESS_SESSION_ID}` })],
    })

    const message = await describeEntry(terminalEntry())

    expect(message?.title).toBe('provider-a · wt-panel')
    expect(sweep(message)).not.toContain(HARNESS_SESSION_ID)
  })

  it('scrubs a terminal title that carries the workspace or working directory path', async () => {
    const { describe: describeEntry } = harness({
      sessions: [terminalSession({ title: `${WORKSPACE_ROOT}/packages/app` })],
    })

    const message = await describeEntry(terminalEntry())

    expect(sweep(message)).not.toContain(WORKSPACE_ROOT)
    expect(sweep(message)).not.toContain(PROJECT_ROOT)
  })

  it('names nothing for a terminal the registry no longer holds', async () => {
    const { describe: describeEntry } = harness({ sessions: [] })

    await expect(describeEntry(terminalEntry())).resolves.toBeUndefined()
  })

  it('falls back to catalog words for a terminal outside every open workspace', async () => {
    const { describe: describeEntry } = harness({
      sessions: [
        terminalSession({
          workspaceRoot: hostPath(LOCAL, '/elsewhere'),
          cwd: hostPath(LOCAL, '/elsewhere'),
          title: '',
        }),
      ],
    })

    const message = await describeEntry(terminalEntry())

    // An empty title is the projection's 'Terminal', not the private-value fallback.
    expect(message).toEqual({ project: 'Project', title: 'Terminal', kind: 'ready' })
  })

  it('describes an external entry with the first prompt line from one supervisor read', async () => {
    const { describe: describeEntry, pendingReads, addressed } = harness()

    const message = await describeEntry(externalEntry())

    expect(message).toEqual({
      project: 'Secret Project',
      title: 'Worker polecat',
      kind: 'ready',
      line: 'Allow the worker to edit src/panel.ts?',
    })
    expect(addressed).toEqual([{ hostId: RIG, cityRoot: CITY_ROOT }])
    expect(pendingReads).toEqual([{ city: 'gastown', session: SESSION_KEY }])
    for (const privateValue of PRIVATE_VALUES) expect(sweep(message)).not.toContain(privateValue)
  })

  it('truncates the prompt line and strips control bytes', async () => {
    const long = `${'x'.repeat(200)}tail`
    const { describe: describeEntry } = harness({
      sessionPending: () =>
        Promise.resolve({
          ok: true,
          value: { supported: true, pending: { kind: 'q', request_id: REQUEST_ID, prompt: long } },
        }),
    })

    const message = await describeEntry(externalEntry())

    expect(message?.line).toHaveLength(PUSH_LINE_MAX)
    expect(message?.line).toBe('x'.repeat(PUSH_LINE_MAX))
  })

  it('still describes an external entry when the supervisor cannot be addressed', async () => {
    const { describe: describeEntry, pendingReads } = harness({
      address: { ok: false, failure: { reason: 'unreachable' } },
    })

    const message = await describeEntry(externalEntry())

    expect(message).toEqual({ project: 'Secret Project', title: 'Worker polecat', kind: 'ready' })
    expect(pendingReads).toEqual([])
  })

  it.each([
    ['a failed read', () => Promise.resolve({ ok: false as const, failure: { reason: 'timeout' as const, detail: 'slow' } })],
    ['an unsupported read', () => Promise.resolve({ ok: true as const, value: { supported: false } })],
    ['a read with no pending prompt', () => Promise.resolve({ ok: true as const, value: { supported: true, pending: { kind: 'q', request_id: REQUEST_ID } } })],
    ['a read that throws', () => Promise.reject(new Error('socket hung up'))],
  ])('omits the line after %s', async (_label, sessionPending) => {
    const { describe: describeEntry } = harness({ sessionPending })

    const message = await describeEntry(externalEntry())

    expect(message).toEqual({ project: 'Secret Project', title: 'Worker polecat', kind: 'ready' })
  })

  it('never lets the session key stand in for a missing external title', async () => {
    const { describe: describeEntry } = harness({
      pending: [pendingSession({ title: undefined })],
    })

    const message = await describeEntry(externalEntry())

    expect(message?.title).toBe('Session')
    expect(sweep(message)).not.toContain(SESSION_KEY)
  })

  it('scrubs an external title that repeats the session key', async () => {
    const { describe: describeEntry } = harness({
      pending: [pendingSession({ title: `worker ${SESSION_KEY}` })],
    })

    const message = await describeEntry(externalEntry())

    expect(sweep(message)).not.toContain(SESSION_KEY)
  })

  it('names nothing for an external entry the rollup no longer lists', async () => {
    const { describe: describeEntry, addressed } = harness({ pending: [] })

    await expect(describeEntry(externalEntry('other'))).resolves.toBeUndefined()
    expect(addressed).toEqual([])
  })

  it('names nothing for an entry that is neither a terminal nor external', async () => {
    const { describe: describeEntry } = harness()

    await expect(
      describeEntry({ key: 'orphan', kind: 'ready', freshness: 'fresh' }),
    ).resolves.toBeUndefined()
  })
})
