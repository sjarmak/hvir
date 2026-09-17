import { describe, expect, it } from 'vitest'

import type {
  CitySessionFact,
  HostCitySessions,
} from '../src/main/gascity/gascity-city-sessions'
import { externalSessionAttachment } from '../src/main/terminal/external-session-attachment'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import type { ObservedManagedPty } from '../src/main/pty/pty-supervisor'
import { assembleSessionsObservation } from '../src/main/sessions/sessions-observation-port'
import {
  SESSIONS_GAS_CITY_PROVIDER,
  projectCitySessions,
} from '../src/main/sessions/sessions-city-projection'
import { createSessionsProjectionIdentityScope } from '../src/main/sessions/sessions-projection-identities'
import {
  resolveSessionsExternalAttach,
  resolveSessionsExternalSession,
} from '../src/main/sessions/sessions-external-resolution'
import {
  SESSIONS_ATTACH_TICKET_TTL_MS,
  SessionsAttachTicketRegistry,
} from '../src/main/sessions/sessions-attach-tickets'
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
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HostPath,
  type ProjectState,
  type SessionsAttachExternalRequest,
  type SessionsObservationSnapshot,
  type SessionsTerminalHandle,
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
        identities.externalSession({
          sourceId: 'gas-city',
          hostId: memRoot.hostId,
          key: `churned-${index}`,
          attachTarget: `churned-${index}`,
        }),
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

describe('A terminal attached to a Gas City session', () => {
  it('is one row: the session, with hvir terminal behind it', () => {
    const source = assemble([hostCity()], {
      sessions: [attachedTerminal('terminal-1', 'gc-mem-worker-1')],
      ptys: [livePty('terminal-1')],
    })

    // Three gc sessions, one of them attached. The attach added no row.
    expect(source.sessions).toHaveLength(3)
    expect([...titles(source)].sort()).toEqual([
      'mem-worker-1',
      'mem-worker-2',
      'polecat-lead',
    ])

    const attached = row(source, 'mem-worker-1')
    // The handle stays hvir's terminal, which is what makes the row openable.
    expect(attached.handle).toBe('terminal-1')
    expect(attached.livePty).toMatchObject({ handle: 'pty-instance-terminal-1' })
    expect(attached.lifecycle).toBe('live')
    // What the row *is* comes from gas city.
    expect(attached.origin).toMatchObject({
      kind: 'external-agent',
      sourceId: 'gas-city',
    })
    expect(attached.providerId).toBe(codex)
    expect(attached.profile).toEqual({ status: 'unsupported' })
    expect(attached.telemetry.context).toMatchObject({
      status: 'available',
      value: { usedPercent: 41 },
    })
    // hvir places its own terminal; gc's working directory does not move it.
    expect(workspaceOf(source, 'mem-worker-1')).toBe('main')
    expect(JSON.stringify(source)).not.toContain('gc-mem-worker-1')
  })

  it('keeps the agent identity when the renderer reports its own shell', () => {
    const source = assemble([hostCity()], {
      sessions: [attachedTerminal('terminal-1', 'gc-mem-worker-1')],
      ptys: [livePty('terminal-1')],
    })
    const workspaceQualifier = source.workspaces.find(
      (candidate) => candidate.workspaceName === 'main',
    )!.qualifier
    const rows = joinSessionsProjection(snapshot(source), [
      {
        handle: 'terminal-1' as (typeof source.sessions)[number]['handle'],
        workspaceQualifier,
        providerId: shell,
        profileId: asHarnessProfileId('plain-shell-default'),
        title: 'Shell · main',
        dormant: false,
        resumeOnStart: false,
        exited: false,
        recoveryUnavailable: false,
      },
    ])

    expect(rows).toHaveLength(3)
    const attached = rows.find((candidate) => candidate.handle === 'terminal-1')!
    expect(attached.title).toBe('mem-worker-1')
    expect(attached.provider).toMatchObject({ id: codex, kind: 'agent' })
    expect(attached.profile).toEqual({ status: 'unsupported' })
    expect(attached.lifecycle).toBe('live')
    // The terminal is still hvir's to open.
    expect(sessionsTerminalSurfaceEligible(attached)).toBe(true)
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

function assemble(
  cities: readonly HostCitySessions[],
  hvir: {
    readonly sessions?: readonly OwnedTerminalSession[]
    readonly ptys?: readonly ObservedManagedPty[]
  } = {},
) {
  return assembleSessionsObservation({
    projectState: projectState(),
    hosts: hostOptions(),
    providers: providers(),
    sessions: hvir.sessions ?? [],
    ptys: hvir.ptys ?? [],
    cities,
  })
}

/** A terminal hvir launched to attach to one gc session, as main recorded it. */
function attachedTerminal(id: string, sessionKey: string): OwnedTerminalSession {
  return {
    id,
    providerId: shell,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    recoverySkipCount: 0,
    attachedExternalSession: externalSessionAttachment({
      sourceId: 'gas-city',
      key: sessionKey,
    }),
    hostId: memRoot.hostId,
    workspaceRoot: memRoot,
    cwd: memRoot,
    title: 'Shell · main',
    position: 0,
    active: true,
    updatedAt: 1,
  }
}

function livePty(id: string): ObservedManagedPty {
  return {
    info: {
      instanceId: `pty-instance-${id}`,
      id,
      ownerId: 7,
      ownerGeneration: 4,
      hostId: memRoot.hostId,
      cwd: memRoot,
      workspaceRoot: memRoot,
      providerId: shell,
      capabilities: {
        sessionIdentity: 'none',
        exactResume: false,
        contextPresentation: 'none',
      },
      profileId: asHarnessProfileId('plain-shell-default'),
      pid: 123,
      startedAt: 1,
      resumed: false,
      identityStatus: 'none',
    },
    telemetry: undefined,
  }
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
    attachTarget: overrides.label,
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

describe('exact resolution from a projected Gas City row', () => {
  it('answers what a row stands for and where an attach would land', () => {
    const identities = createSessionsProjectionIdentityScope()
    const observation = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions: [],
      ptys: [],
      cities: [hostCity()],
      identities,
    })
    const worker = row(observation, 'mem-worker-1')
    const workspace = observation.workspaces.find(
      (candidate) => candidate.workspaceId === worker.workspaceId,
    )!

    expect(
      resolveSessionsExternalSession({
        request: {
          handle: worker.handle,
          projectionDemandGeneration: 3,
          sourceRevision: 5,
        },
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
      }),
    ).toEqual({
      outcome: 'resolved',
      // The foreign identifier and the city root live here, on main's side of
      // the boundary, and nowhere in the projection the renderer holds.
      target: {
        sourceId: 'gas-city',
        hostId: memRoot.hostId,
        key: 'gc-mem-worker-1',
        attachTarget: 'mem-worker-1',
        cityRoot: city,
      },
      live: false,
    })
    expect(
      resolveSessionsExternalAttach({
        request: attachRequest(worker.handle, workspace),
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
        projectState: projectState(),
      }),
    ).toMatchObject({
      outcome: 'resolved',
      projectId: `project:local:${memRoot.path}`,
      workspaceId: `workspace:local:${memPanel.path}`,
      attachTarget: 'mem-worker-1',
    })
  })

  it('refuses a row hvir owns outright and a projection that moved on', () => {
    const identities = createSessionsProjectionIdentityScope()
    const observation = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions: [ownTerminal('own-shell')],
      ptys: [],
      cities: [hostCity()],
      identities,
    })
    const own = row(observation, 'Shell · main')
    const worker = row(observation, 'mem-worker-1')
    const workspace = observation.workspaces.find(
      (candidate) => candidate.workspaceId === worker.workspaceId,
    )!

    // hvir's own terminal is a session, but not one any supervisor can be asked
    // about: there is no exact join recorded for it.
    expect(
      resolveSessionsExternalSession({
        request: { handle: own.handle, projectionDemandGeneration: 3, sourceRevision: 5 },
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'not-projected' })
    expect(
      resolveSessionsExternalSession({
        request: {
          handle: worker.handle,
          projectionDemandGeneration: 3,
          sourceRevision: 4,
        },
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'stale-projection' })
    expect(
      resolveSessionsExternalAttach({
        request: attachRequest(own.handle, workspace),
        activeDemandGeneration: 3,
        sourceRevision: 5,
        observation,
        identities,
        projectState: projectState(),
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'not-projected' })
  })

  it('mints a single-use ticket so a renderer can attach without the identifier', () => {
    const registry = new SessionsAttachTicketRegistry()
    const owner = { id: 7, generation: 4 }
    const attach = { sourceId: 'gas-city' as const, key: 'gc-mem-worker-1' }
    const ticket = registry.mint(owner, attach)

    expect(ticket).toMatch(/^[a-f0-9]{32}$/)
    expect(registry.redeem(owner, ticket)).toEqual(attach)
    // Spent: a second launch asks for a second ticket.
    expect(registry.redeem(owner, ticket)).toBeUndefined()
    // Another renderer, or the same one after a rollover, cannot spend it.
    const second = registry.mint(owner, attach)
    expect(registry.redeem({ id: 7, generation: 5 }, second)).toBeUndefined()
    expect(registry.redeem(owner, 'not-a-ticket')).toBeUndefined()
  })

  it('drops a ticket nobody redeemed before it went stale', () => {
    let now = 1_000
    const registry = new SessionsAttachTicketRegistry({ now: () => now })
    const owner = { id: 7, generation: 4 }
    const ticket = registry.mint(owner, { sourceId: 'gas-city', key: 'gc-mem-worker-1' })
    now += SESSIONS_ATTACH_TICKET_TTL_MS + 1

    expect(registry.redeem(owner, ticket)).toBeUndefined()
  })
})

function attachRequest(
  handle: SessionsTerminalHandle,
  workspace: SessionsObservationSnapshot['workspaces'][number],
): SessionsAttachExternalRequest {
  return {
    demandGeneration: 3,
    sourceRevision: 5,
    handle,
    projectId: workspace.projectId,
    workspaceId: workspace.workspaceId,
    workspaceQualifier: workspace.qualifier,
  }
}

/** A terminal hvir launched itself, attached to nothing foreign. */
function ownTerminal(id: string): OwnedTerminalSession {
  const { attachedExternalSession: _attached, ...rest } = attachedTerminal(id, 'unused')
  return rest
}
