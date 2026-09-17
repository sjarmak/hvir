import { describe, expect, it } from 'vitest'

import type {
  CitySessionFact,
  HostCitySessions,
} from '../src/main/gascity/gascity-city-sessions'
import { assembleSessionsObservation } from '../src/main/sessions/sessions-observation-port'
import {
  SESSIONS_GAS_CITY_PROVIDER,
  projectCitySessions,
} from '../src/main/sessions/sessions-city-projection'
import { createSessionsProjectionIdentityScope } from '../src/main/sessions/sessions-projection-identities'
import { joinSessionsProjection } from '../src/renderer/src/sessions/sessions-projection-coordinator'
import {
  DEFAULT_SESSIONS_OVERVIEW_POLICY,
  SESSIONS_OVERVIEW_PAGE_SIZE,
  sessionsOverviewGroups,
  sessionsOverviewPage,
} from '../src/renderer/src/sessions/sessions-overview-model'
import { sessionsTerminalSurfaceEligible } from '../src/renderer/src/sessions/sessions-terminal-surface'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  asHarnessProviderId,
  localPath,
  type HostPath,
  type ProjectState,
  type SessionsObservationSnapshot,
} from '../src/shared'

const codex = asHarnessProviderId('codex')
const shell = asHarnessProviderId('plain-shell')
const city = localPath('/private/city')
const memRoot = localPath('/private/city/rigs/mem')
const memPanel = localPath('/private/city/rigs/mem/worktrees/panel')
const memUnknown = localPath('/private/city/rigs/mem/worktrees/not-registered')
const polecatRoot = localPath('/private/city/rigs/polecat')
const unrelated = localPath('/private/elsewhere/repo')

describe('Gas City sessions in the global projection', () => {
  it('groups every placeable session under the project and workspace that owns it', () => {
    const source = assemble([hostCity()])

    expect(titles(source)).toEqual(['mem-worker-1', 'mem-worker-2', 'polecat-lead'])
    expect(workspaceOf(source, 'mem-worker-1')).toBe('panel')
    // An unknown worktree still belongs to the rig it sits in: the project is a
    // fact, the workspace inside it is not.
    expect(workspaceOf(source, 'mem-worker-2')).toBe('main')
    // No working directory at all, so only the rig places it.
    expect(workspaceOf(source, 'polecat-lead')).toBe('polecat-main')
    expect(projectOf(source, 'polecat-lead')).toBe('Polecat rig')
  })

  it('drops a session it cannot place rather than filing it under a stranger', () => {
    const source = assemble([
      hostCity({
        sessions: [
          fact({ sessionKey: 'gc-orphan', label: 'orphan', workDir: unrelated }),
        ],
      }),
    ])

    expect(source.sessions).toEqual([])
  })

  it('keeps gas city identifiers and paths out of the snapshot entirely', () => {
    const source = assemble([hostCity()])
    const serialized = JSON.stringify(source)

    for (const secret of [
      'gc-mem-worker-1',
      'gc-mem-worker-2',
      'gc-polecat-lead',
      '/private/',
      'worktrees/not-registered',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    for (const row of source.sessions) {
      expect(String(row.handle)).toMatch(/^sessions-external-\d{4}$/)
      expect(row.origin).toEqual({
        kind: 'external-agent',
        sourceId: 'gas-city',
        sourceName: 'Gas City',
      })
    }
  })

  it('reports only what gas city knows, and offers no terminal for it', () => {
    const source = assemble([hostCity()])
    const worker = row(source, 'mem-worker-1')

    expect(worker).toMatchObject({ providerId: codex, lifecycle: 'live' })
    expect(worker.profile).toEqual({ status: 'unsupported' })
    expect(worker.telemetry.model).toEqual({ status: 'unsupported' })
    expect(worker.telemetry.turn).toEqual({ status: 'unsupported' })
    const context = worker.telemetry.context
    if (context.status !== 'available') throw new Error('expected a reported context')
    // A percentage with no token count behind it stays a percentage.
    expect(context.value).toEqual({ usedPercent: 41 })
    expect(worker.livePty).toBeUndefined()
    expect(row(source, 'polecat-lead').lifecycle).toBe('retained')
  })

  it('names the source as the provider when the harness is not one hvir registered', () => {
    const source = assemble([hostCity()])

    expect(row(source, 'polecat-lead').providerId).toBe(SESSIONS_GAS_CITY_PROVIDER.id)
    expect(source.providers).toContainEqual(SESSIONS_GAS_CITY_PROVIDER)
  })

  it('leaves the source provider out when every row kept a registered harness', () => {
    const source = assemble([
      hostCity({
        sessions: [
          fact({
            sessionKey: 'gc-only',
            label: 'only',
            workDir: memRoot,
            provider: 'codex',
          }),
        ],
      }),
    ])

    expect(source.providers.map((provider) => provider.id)).toEqual([codex, shell])
  })

  it('reports an unavailable city as stale rows instead of an empty list', () => {
    const source = assemble([hostCity({ stale: true })])
    const worker = row(source, 'mem-worker-1')

    expect(source.sessions).toHaveLength(3)
    expect(worker.telemetry.freshness).toMatchObject({
      status: 'stale',
      reason: 'source-unavailable',
    })
    expect(worker.telemetry.context).toMatchObject({
      status: 'stale',
      reason: 'source-unavailable',
    })
  })

  it('never projects a city on a host hvir has no workspace on', () => {
    const source = assemble([{ ...hostCity(), root: localPath('/private/city') }])
    const elsewhere = assembleSessionsObservation({
      projectState: { ...projectState(), projects: [] },
      hosts: hostOptions(),
      providers: providers(),
      sessions: [],
      ptys: [],
      cities: [hostCity()],
    })

    expect(source.sessions).toHaveLength(3)
    expect(elsewhere.sessions).toEqual([])
  })

  it('drops a session once the demand can mint no more opaque handles', () => {
    const identities = createSessionsProjectionIdentityScope()
    // A foreign source can churn identifiers all demand long; past the mint cap
    // the session is dropped rather than shown under a foreign identifier.
    for (let index = 0; index < MAX_SESSIONS_PROJECTION_ROWS * 2; index += 1) {
      expect(
        identities.externalSession({ sourceId: 'gas-city', key: `churned-${index}` }),
      ).toBeDefined()
    }
    const main = assemble([]).workspaces.find(
      (candidate) => candidate.workspaceName === 'main',
    )
    if (main === undefined) throw new Error('expected a main workspace')

    const projection = projectCitySessions({
      cities: [hostCity()],
      workspaces: [{ root: memRoot, projectRoot: memRoot, workspace: main }],
      identities,
      providers: new Map(),
      capacity: MAX_SESSIONS_PROJECTION_ROWS,
    })

    expect(projection.sessions).toEqual([])
  })

  it('stops at the rows the projection has left', () => {
    // The workspace comes from a real assembly, so the projection is handed the
    // same shape the port hands it.
    const main = assemble([]).workspaces.find(
      (candidate) => candidate.workspaceName === 'main',
    )
    if (main === undefined) throw new Error('expected a main workspace')
    const projection = projectCitySessions({
      cities: [hostCity()],
      workspaces: [{ root: memRoot, projectRoot: memRoot, workspace: main }],
      identities: createSessionsProjectionIdentityScope(),
      providers: new Map(),
      capacity: 1,
    })

    expect(projection.sessions).toHaveLength(1)
  })
})

describe('Gas City rows in the overview model', () => {
  it('filters, groups, sorts, and pages alongside hvir own sessions', () => {
    const facts = Array.from({ length: SESSIONS_OVERVIEW_PAGE_SIZE + 5 }, (_, index) =>
      fact({
        sessionKey: `gc-worker-${index}`,
        label: `worker-${String(index).padStart(2, '0')}`,
        workDir: index % 2 === 0 ? memPanel : polecatRoot,
      }),
    )
    const rows = joinSessionsProjection(
      snapshot(assemble([hostCity({ sessions: facts })])),
      [],
    )

    expect(rows).toHaveLength(facts.length)
    expect(rows.every((candidate) => candidate.provider.kind === 'agent')).toBe(true)
    expect(rows.every((candidate) => !sessionsTerminalSurfaceEligible(candidate))).toBe(
      true,
    )

    const shells = sessionsOverviewGroups(rows, {
      ...DEFAULT_SESSIONS_OVERVIEW_POLICY,
      filter: 'shells',
    })
    expect(shells.flatMap((group) => group.rows)).toEqual([])

    const grouped = sessionsOverviewGroups(rows, {
      filter: 'harnesses',
      group: 'workspace',
      sort: 'title',
    })
    expect(grouped.map((group) => group.label)).toEqual(['Memory rig', 'Polecat rig'])
    expect(
      grouped.flatMap((group) => group.rows.map((candidate) => candidate.title)),
    ).toEqual([
      ...facts
        .filter((candidate) => candidate.workDir === memPanel)
        .map((candidate) => candidate.label),
      ...facts
        .filter((candidate) => candidate.workDir === polecatRoot)
        .map((candidate) => candidate.label),
    ])

    const page = sessionsOverviewPage(grouped, 0)
    expect(page.pageCount).toBe(2)
    expect(page.rows).toHaveLength(SESSIONS_OVERVIEW_PAGE_SIZE)
    expect(sessionsOverviewPage(grouped, 1).rows).toHaveLength(5)
  })
})

function assemble(cities: readonly HostCitySessions[]) {
  return assembleSessionsObservation({
    projectState: projectState(),
    hosts: hostOptions(),
    providers: providers(),
    sessions: [],
    ptys: [],
    cities,
  })
}

function snapshot(base: ReturnType<typeof assemble>): SessionsObservationSnapshot {
  return { ...base, demandGeneration: 1, revision: 1 }
}

function titles(source: ReturnType<typeof assemble>): readonly string[] {
  return source.sessions.map((session) => session.title)
}

function row(source: ReturnType<typeof assemble>, title: string) {
  const found = source.sessions.find((session) => session.title === title)
  if (found === undefined) throw new Error(`no projected session titled ${title}`)
  return found
}

function workspaceOf(
  source: ReturnType<typeof assemble>,
  title: string,
): string | undefined {
  const workspaceId = row(source, title).workspaceId
  return source.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    ?.workspaceName
}

function projectOf(
  source: ReturnType<typeof assemble>,
  title: string,
): string | undefined {
  const workspaceId = row(source, title).workspaceId
  return source.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    ?.projectName
}

function hostCity(
  overrides: {
    readonly sessions?: readonly CitySessionFact[]
    readonly stale?: boolean
  } = {},
): HostCitySessions {
  return {
    root: memRoot,
    cityRoot: city,
    observedAt: 1_700_000_000_000,
    staleAfterMs: 3_000,
    stale: overrides.stale === true,
    sessions: overrides.sessions ?? [
      fact({
        sessionKey: 'gc-mem-worker-1',
        label: 'mem-worker-1',
        workDir: memPanel,
        rigRoot: memRoot,
        provider: 'codex',
        contextPercent: 41,
      }),
      fact({
        sessionKey: 'gc-mem-worker-2',
        label: 'mem-worker-2',
        workDir: memUnknown,
        rigRoot: memRoot,
      }),
      fact({
        sessionKey: 'gc-polecat-lead',
        label: 'polecat-lead',
        tier: 'lead',
        cityLead: true,
        rigRoot: polecatRoot,
        state: 'asleep',
      }),
    ],
  }
}

function fact(
  overrides: Partial<CitySessionFact> & {
    readonly sessionKey: string
    readonly label: string
  },
): CitySessionFact {
  const state = overrides.state ?? 'active'
  return {
    tier: 'worker',
    ...overrides,
    state,
    activity: state === 'active' ? 'active' : 'idle',
  }
}

function projectState(): ProjectState {
  const memProjectId = `project:local:${memRoot.path}`
  const polecatProjectId = `project:local:${polecatRoot.path}`
  return {
    revision: 1,
    root: memRoot,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: memProjectId,
    activeWorkspaceId: `workspace:local:${memRoot.path}`,
    projects: [
      {
        id: memProjectId,
        registeredRoot: memRoot,
        displayName: 'Memory rig',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: `workspace:local:${memRoot.path}`,
        workspaces: [
          workspace(memRoot, 'main', true),
          workspace(memPanel, 'panel', false),
        ],
      },
      {
        id: polecatProjectId,
        registeredRoot: polecatRoot,
        displayName: 'Polecat rig',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: `workspace:local:${polecatRoot.path}`,
        workspaces: [workspace(polecatRoot, 'polecat-main', true)],
      },
    ],
  }
}

function workspace(root: HostPath, name: string, main: boolean) {
  return {
    id: `workspace:local:${root.path}`,
    root,
    name,
    main,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
}

function hostOptions() {
  return [
    {
      hostId: 'local',
      label: 'Local',
      kind: 'local' as const,
      connectionState: 'connected' as const,
      watchTier: 'native' as const,
    },
  ]
}

function providers() {
  return [
    {
      id: codex,
      displayName: 'Codex',
      telemetrySupported: true,
      sessionKind: 'agent' as const,
    },
    {
      id: shell,
      displayName: 'Shell',
      telemetrySupported: false,
      sessionKind: 'shell' as const,
    },
  ]
}
