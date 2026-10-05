import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import { externalSessionAttachment } from '../src/main/terminal/external-session-attachment'
import { assembleSessionsObservation } from '../src/main/sessions/sessions-observation-port'
import {
  SESSIONS_GAS_CITY_PROVIDER,
  cityPendingSignals,
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
  asHarnessProfileId,
  asHostId,
  asSessionsProjectHandle,
  asSessionsWorkspaceHandle,
  hostPath,
  localPath,
} from '../src/shared'

import {
  codex,
  shell,
  memRoot,
  memPanel,
  polecatRoot,
  unrelated,
  assemble,
  attachedTerminal,
  livePty,
  snapshot,
  titles,
  row,
  workspaceOf,
  projectOf,
  hostCity,
  fact,
  projectState,
  hostOptions,
  providers,
  cityEvents,
  pendingFor,
} from './sessions-city-fixtures'

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

  it('deduplicates every generated attached session identity into one row', () =>
    hegel.test((testCase) => {
      const suffix = testCase.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 }))
      const sessionKey = `gc-generated-${suffix}`
      const title = `generated-${suffix}`
      const source = assemble(
        [
          hostCity({
            sessions: [
              fact({ sessionKey, label: title, workDir: memPanel, rigRoot: memRoot }),
            ],
          }),
        ],
        {
          sessions: [attachedTerminal('terminal-generated', sessionKey)],
          ptys: [livePty('terminal-generated')],
        },
      )

      expect(source.sessions).toHaveLength(1)
      expect(row(source, title).handle).toBe('terminal-generated')
    }))

  it('joins only the matching host when two cities use the same session key', () => {
    const remoteHost = asHostId('ssh-prod')
    const remoteRoot = hostPath(remoteHost, '/srv/city/rigs/mem')
    const localWorkspace = assemble([]).workspaces.find(
      (candidate) => candidate.workspaceName === 'main',
    )!
    const remoteWorkspace = {
      projectId: asSessionsProjectHandle('sessions-project-remote'),
      projectName: 'Remote rig',
      workspaceId: asSessionsWorkspaceHandle('sessions-workspace-remote'),
      qualifier: localWorkspace.qualifier,
      workspaceName: 'remote-main',
      main: true,
      closed: false,
      missing: false,
      host: {
        id: remoteHost,
        label: 'Production',
        kind: 'ssh' as const,
        connectionState: 'connected' as const,
      },
    }
    const terminal = assemble([], {
      sessions: [attachedTerminal('terminal-shared', 'shared-key')],
      ptys: [livePty('terminal-shared')],
    }).sessions[0]!
    const projection = projectCitySessions({
      cities: [
        hostCity({
          sessions: [
            fact({ sessionKey: 'shared-key', label: 'local-session', rigRoot: memRoot }),
          ],
        }),
        {
          ...hostCity({
            sessions: [
              fact({
                sessionKey: 'shared-key',
                label: 'remote-session',
                rigRoot: remoteRoot,
              }),
            ],
          }),
          root: remoteRoot,
          cityRoot: hostPath(remoteHost, '/srv/city'),
        },
      ],
      workspaces: [
        { root: memRoot, projectRoot: memRoot, workspace: localWorkspace },
        { root: remoteRoot, projectRoot: remoteRoot, workspace: remoteWorkspace },
      ],
      identities: createSessionsProjectionIdentityScope(),
      providers: new Map(),
      capacity: 2,
      attached: [
        {
          attachment: externalSessionAttachment({
            sourceId: 'gas-city',
            key: 'shared-key',
          }),
          session: terminal,
        },
      ],
    })

    expect(projection.merged.get('terminal-shared')?.title).toBe('local-session')
    expect(projection.sessions.map((session) => session.title)).toEqual([
      'remote-session',
    ])
  })

  it('joins a terminal attached by agent alias when no session id was known', () => {
    const source = assemble([hostCity()], {
      sessions: [attachedTerminal('terminal-alias', undefined, 'mem-worker-1')],
      ptys: [livePty('terminal-alias')],
    })

    expect(source.sessions).toHaveLength(3)
    expect(row(source, 'mem-worker-1').handle).toBe('terminal-alias')
  })

  it('joins by alias after gc restarts the agent under a new session id', () => {
    const source = assemble([hostCity()], {
      sessions: [attachedTerminal('terminal-old', 'gc-mem-worker-1-old', 'mem-worker-1')],
      ptys: [livePty('terminal-old')],
    })

    expect(source.sessions).toHaveLength(3)
    expect(row(source, 'mem-worker-1').handle).toBe('terminal-old')
  })

  it('still merges an attached session after unattached rows fill capacity', () => {
    const workspace = assemble([]).workspaces.find(
      (candidate) => candidate.workspaceName === 'main',
    )!
    const terminal = assemble([], {
      sessions: [attachedTerminal('terminal-late', 'attached-late')],
      ptys: [livePty('terminal-late')],
    }).sessions[0]!
    const projection = projectCitySessions({
      cities: [
        hostCity({
          sessions: [
            fact({ sessionKey: 'unattached-first', label: 'first', rigRoot: memRoot }),
            fact({
              sessionKey: 'attached-late',
              label: 'attached',
              rigRoot: memRoot,
            }),
          ],
        }),
      ],
      workspaces: [{ root: memRoot, projectRoot: memRoot, workspace }],
      identities: createSessionsProjectionIdentityScope(),
      providers: new Map(),
      capacity: 0,
      attached: [
        {
          attachment: externalSessionAttachment({
            sourceId: 'gas-city',
            key: 'attached-late',
          }),
          session: terminal,
        },
      ],
    })

    expect(projection.sessions).toEqual([])
    expect(projection.merged.get('terminal-late')?.title).toBe('attached')
  })
})

describe('A Gas City session waiting on a person', () => {
  it('makes the row actionable attention, and says the turn is theirs', () => {
    const source = assemble([hostCity()], {
      events: [cityEvents({ pending: [pendingFor('gc-mem-worker-1')] })],
    })
    const waiting = row(source, 'mem-worker-1')

    expect(waiting.attention).toEqual({
      status: 'available',
      value: 'ready',
      observedAt: 1_700_000_000_000,
    })
    expect(waiting.telemetry.turn).toEqual({
      status: 'available',
      value: { state: 'waiting-for-user' },
      observedAt: 1_700_000_000_000,
    })
  })

  it('leaves every other row reporting nothing about attention', () => {
    const source = assemble([hostCity()], {
      events: [cityEvents({ pending: [pendingFor('gc-mem-worker-1')] })],
    })
    const quiet = row(source, 'mem-worker-2')

    // Not "no attention": gc declared nothing about this session, and an
    // absent declaration is not a declaration of absence (ADR-948).
    expect(quiet.attention).toBeUndefined()
    expect(quiet.telemetry.turn).toEqual({ status: 'unsupported' })
  })

  it('marks the attention stale with its reason when the stream is lost', () => {
    const source = assemble([hostCity()], {
      events: [
        cityEvents({
          stream: 'lost',
          reason: 'unreachable',
          pending: [pendingFor('gc-mem-worker-1')],
        }),
      ],
    })
    const waiting = row(source, 'mem-worker-1')

    // Kept, not dropped, and not asserted: nobody is watching this host.
    expect(waiting.attention).toEqual({
      status: 'stale',
      value: 'ready',
      observedAt: 1_700_000_000_000,
      reason: 'source-stale',
    })
    expect(waiting.telemetry.turn).toMatchObject({
      status: 'stale',
      reason: 'source-stale',
    })
  })

  it('marks the attention stale when the session list itself is stale', () => {
    const source = assemble([hostCity({ stale: true })], {
      events: [cityEvents({ pending: [pendingFor('gc-mem-worker-1')] })],
    })

    expect(row(source, 'mem-worker-1').attention).toMatchObject({
      status: 'stale',
      reason: 'source-stale',
    })
  })

  it('says nothing about a session no row stands for', () => {
    const source = assemble([hostCity()], {
      events: [cityEvents({ pending: [pendingFor('gc-not-projected')] })],
    })

    expect(
      source.sessions.filter((session) => session.attention !== undefined),
    ).toHaveLength(0)
  })

  it('reduces a city list to one signal per session', () => {
    const signals = cityPendingSignals([
      cityEvents({
        pending: [
          pendingFor('gc-mem-worker-1'),
          // A session may be waiting on more than one interaction; the row is
          // waiting or it is not.
          pendingFor('gc-mem-worker-1', 'req-2'),
          pendingFor('gc-mem-worker-2'),
        ],
      }),
    ])

    expect(signals).toEqual([
      { hostId: memRoot.hostId, sessionKey: 'gc-mem-worker-1' },
      { hostId: memRoot.hostId, sessionKey: 'gc-mem-worker-2' },
    ])
  })

  it('carries the reason a signal is no longer being watched', () => {
    const signals = cityPendingSignals([
      cityEvents({
        stream: 'unavailable',
        reason: 'disabled',
        pending: [pendingFor('gc-mem-worker-1')],
      }),
    ])

    expect(signals).toEqual([
      { hostId: memRoot.hostId, sessionKey: 'gc-mem-worker-1', stale: true },
    ])
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
