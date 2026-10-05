import type {
  CitySessionFact,
  HostCitySessions,
} from '../src/main/gascity/gascity-city-sessions'
import { externalSessionAttachment } from '../src/main/terminal/external-session-attachment'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import type { ObservedManagedPty } from '../src/main/pty/pty-supervisor'
import { assembleSessionsObservation } from '../src/main/sessions/sessions-observation-port'
import type { HostCityEvents } from '../src/main/gascity/city-event-facts'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HostPath,
  type ProjectState,
  type SessionsObservationSnapshot,
} from '../src/shared'

export const codex = asHarnessProviderId('codex')
export const shell = asHarnessProviderId('plain-shell')
export const city = localPath('/private/city')
export const memRoot = localPath('/private/city/rigs/mem')
export const memPanel = localPath('/private/city/rigs/mem/worktrees/panel')
export const memUnknown = localPath('/private/city/rigs/mem/worktrees/not-registered')
export const polecatRoot = localPath('/private/city/rigs/polecat')
export const unrelated = localPath('/private/elsewhere/repo')

export function assemble(
  cities: readonly HostCitySessions[],
  hvir: {
    readonly sessions?: readonly OwnedTerminalSession[]
    readonly ptys?: readonly ObservedManagedPty[]
    readonly events?: readonly HostCityEvents[]
  } = {},
) {
  return assembleSessionsObservation({
    projectState: projectState(),
    hosts: hostOptions(),
    providers: providers(),
    sessions: hvir.sessions ?? [],
    ptys: hvir.ptys ?? [],
    cities,
    ...(hvir.events === undefined ? {} : { events: hvir.events }),
  })
}

/** A terminal hvir launched to attach to one gc session, as main recorded it. */
export function attachedTerminal(
  id: string,
  sessionKey: string | undefined,
  alias?: string,
): OwnedTerminalSession {
  return {
    id,
    providerId: shell,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    recoverySkipCount: 0,
    attachedExternalSession: externalSessionAttachment({
      sourceId: 'gas-city',
      ...(sessionKey === undefined ? {} : { key: sessionKey }),
      ...(alias === undefined ? {} : { alias }),
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

export function livePty(id: string): ObservedManagedPty {
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

export function snapshot(base: ReturnType<typeof assemble>): SessionsObservationSnapshot {
  return { ...base, demandGeneration: 1, revision: 1 }
}

export function titles(source: ReturnType<typeof assemble>): readonly string[] {
  return source.sessions.map((session) => session.title)
}

export function row(source: ReturnType<typeof assemble>, title: string) {
  const found = source.sessions.find((session) => session.title === title)
  if (found === undefined) throw new Error(`no projected session titled ${title}`)
  return found
}

export function workspaceOf(
  source: ReturnType<typeof assemble>,
  title: string,
): string | undefined {
  const workspaceId = row(source, title).workspaceId
  return source.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    ?.workspaceName
}

export function projectOf(
  source: ReturnType<typeof assemble>,
  title: string,
): string | undefined {
  const workspaceId = row(source, title).workspaceId
  return source.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    ?.projectName
}

export function hostCity(
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

export function fact(
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

export function projectState(): ProjectState {
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

export function workspace(root: HostPath, name: string, main: boolean) {
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

export function hostOptions() {
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

export function providers() {
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

export function cityEvents(
  overrides: {
    readonly stream?: HostCityEvents['stream']
    readonly reason?: HostCityEvents['reason']
    readonly pending?: HostCityEvents['pending']
  } = {},
): HostCityEvents {
  return {
    hostId: memRoot.hostId,
    cityRoot: city,
    stream: overrides.stream ?? 'live',
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
    observedAt: 1_700_000_000_000,
    lifecycle: [],
    pending: overrides.pending ?? [],
  }
}

export function pendingFor(sessionKey: string, requestId = 'req-1') {
  return { sessionKey, requestId, kind: 'tool-approval' }
}
