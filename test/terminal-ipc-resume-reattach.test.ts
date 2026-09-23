import { describe, expect, it, vi } from 'vitest'

import {
  harnessLaunchCapabilities,
  harnessProvider,
} from '../src/main/harness/harness-provider'
import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import {
  IpcAuthority,
  type IpcInvokeContext,
  type IpcRegistrar,
} from '../src/main/ipc/authority-router'
import type { ProjectHost } from '../src/main/project-host'
import type { ManagedPty } from '../src/main/pty/pty-supervisor'
import type { RecordTerminalReplacement } from '../src/main/terminal/session-registry'
import {
  LOCAL_HOST_ID,
  asHostId,
  hostPath,
  hostPathEquals,
  type HostPath,
  type ProjectState,
  type RebindTerminalProfileRequest,
  type StartPtyRequest,
  type StartPtyResponse,
  type TerminalRecoverySession,
} from '../src/shared'

const HARNESS_SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

/** A well-formed Sessions attach ticket; the registry decides what it means. */
const TICKET = 'b'.repeat(32)

describe('terminal exact-resume IPC', () => {
  it('falls back to exact resume when the transferred PTY exits before reattachment', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    fixture.hasTransferredResource.mockReturnValue(true)

    const result = await fixture.start(fixture.request, fixture.context)

    expect(result).toMatchObject({
      outcome: 'started',
      id: 'terminal-1',
      resumed: true,
      reattached: false,
    })
    expect(fixture.authorizeReattach).toHaveBeenCalledOnce()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
    expect(fixture.defaultShell).toHaveBeenCalledOnce()
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.register).toHaveBeenCalledOnce()
  })

  it('rejects a same-generation duplicate start instead of double-attaching', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')
    fixture.register.mockImplementationOnce(() => {
      throw new Error('Renderer pty-session resource is already registered')
    })

    await expect(fixture.start(fixture.request, fixture.context)).rejects.toThrow(
      'already registered',
    )

    expect(fixture.hasTransferredResource).toHaveBeenCalledOnce()
    expect(fixture.claimTransferredResource).not.toHaveBeenCalled()
    expect(fixture.get).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.attach).not.toHaveBeenCalled()
  })

  it('keeps one renderer forwarding lease until the supervised PTY exits', async () => {
    const fixture = resumeFixture(asHostId('ssh-control-reconnect'), 'available')

    await fixture.start(fixture.request, fixture.context)
    const handlers = fixture.attach.mock.calls[0]?.[2]
    if (!handlers) throw new Error('Expected the renderer PTY forwarding attachment')

    handlers.onData?.('output during control reconnect')
    expect(fixture.send).toHaveBeenCalledWith('pty:data', {
      id: 'terminal-1',
      data: 'output during control reconnect',
    })
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.register).toHaveBeenCalledOnce()
    expect(fixture.lease.release).not.toHaveBeenCalled()

    handlers.onExit?.({ exitCode: 255, signal: undefined })
    expect(fixture.lease.release).toHaveBeenCalledOnce()
    expect(fixture.send).toHaveBeenCalledWith('pty:exit', {
      id: 'terminal-1',
      exitCode: 255,
      signal: undefined,
    })
  })

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-replacement-test')],
  ])(
    'commits an intentional fresh replacement with new identities on a %s ProjectHost',
    async (_kind, hostId) => {
      const fixture = resumeFixture(hostId, 'missing')
      const request: StartPtyRequest = {
        ...fixture.request,
        sessionId: 'terminal-2',
        replacesSessionId: 'terminal-1',
        resume: false,
        harnessSessionId: undefined,
      }

      const result = await fixture.start(request, fixture.context)

      expect(result).toMatchObject({
        outcome: 'started',
        id: 'terminal-2',
        resumed: false,
        harnessSessionId: 'terminal-2',
      })
      expect(fixture.authorizeReplacement).toHaveBeenCalledWith({
        replacedId: 'terminal-1',
        replacementId: 'terminal-2',
        providerId: 'claude-code',
        profileId: request.profileId,
        launchRevision: request.launchRevision,
        workspaceRoot: fixture.root,
        cwd: fixture.root,
      })
      expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'terminal-2',
        launchSpec: {
          file: 'claude',
          args: ['--session-id', 'terminal-2'],
        },
        resume: false,
        harnessSessionId: undefined,
      })
      expect(fixture.recordReplacement).toHaveBeenCalledOnce()
      expect(fixture.recordReplacement.mock.calls[0]?.[0]).toMatchObject({
        replacedId: 'terminal-1',
        spawn: {
          id: 'terminal-2',
          harnessSessionId: 'terminal-2',
        },
      })
      expect(fixture.recordSpawn).not.toHaveBeenCalled()
    },
  )

  it('keeps the source record and disposes the fresh PTY when replacement persistence fails', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.recordReplacement.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          sessionId: 'terminal-2',
          replacesSessionId: 'terminal-1',
          resume: false,
          harnessSessionId: undefined,
        },
        fixture.context,
      ),
    ).rejects.toThrow('disk unavailable')

    expect(fixture.recordSpawn).not.toHaveBeenCalled()
    expect(fixture.lease.dispose).toHaveBeenCalledOnce()
  })

  it('terminates a transferred PTY when recovery is intentionally skipped', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.hasTransferredResource.mockReturnValue(true)

    await fixture.recordRecoveryDecision(
      {
        root: fixture.root,
        restoredIds: [],
        skippedIds: ['terminal-1'],
      },
      fixture.context,
    )

    expect(fixture.persistRecoveryDecision).toHaveBeenCalledWith(fixture.root, {
      restoredIds: [],
      skippedIds: ['terminal-1'],
    })
    expect(fixture.disposeResource).toHaveBeenCalledWith(
      { id: 7, generation: 1 },
      'pty-session',
      'terminal-1',
    )
  })

  it('contains a classified fresh-launch failure without retaining resources', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'missing')
    fixture.spawn.mockRejectedValueOnce(new Error('spawn ENOENT'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          resume: false,
          harnessSessionId: undefined,
        },
        fixture.context,
      ),
    ).rejects.toThrow('spawn ENOENT')

    expect(fixture.lease.dispose).toHaveBeenCalledOnce()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
    expect(fixture.recordSuccessfulLaunch).not.toHaveBeenCalled()
    expect(fixture.refreshProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        host: fixture.host,
        profiles: [fixture.profile],
      }),
      fixture.profile,
    )
  })

  it('refuses a disconnected fresh launch before allocating a renderer lease', async () => {
    const fixture = resumeFixture(asHostId('ssh-disconnected-launch'), 'missing')
    Object.assign(fixture.host, { connectionState: 'disconnected' })
    fixture.defaultShell.mockRejectedValueOnce(new Error('SSH host is disconnected'))

    await expect(
      fixture.start(
        {
          ...fixture.request,
          resume: false,
          harnessSessionId: undefined,
        },
        fixture.context,
      ),
    ).rejects.toThrow('SSH host is disconnected')

    expect(fixture.register).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
  })

  it('records the session a Sessions attach ticket stands for', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')

    const result = await fixture.start(
      {
        ...fixture.request,
        resume: false,
        harnessSessionId: undefined,
        externalAttach: { ticket: TICKET },
      },
      fixture.context,
    )

    expect(result).toMatchObject({ outcome: 'started' })
    expect(fixture.redeemTicket).toHaveBeenCalledWith({ id: 7, generation: 1 }, TICKET)
    // The renderer sent a ticket; what persists is the session main redeemed it
    // for, so the join is exact without the identifier ever crossing IPC.
    expect(fixture.recordSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        externalAttach: { sourceId: 'gas-city', key: 'mem-worker-1' },
      }),
    )
  })

  it('refuses a launch whose attach ticket is not redeemable', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')

    await expect(
      fixture.start(
        {
          ...fixture.request,
          resume: false,
          harnessSessionId: undefined,
          externalAttach: { ticket: 'c'.repeat(32) },
        },
        fixture.context,
      ),
    ).rejects.toThrow('Sessions attach ticket is not redeemable')

    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.recordSpawn).not.toHaveBeenCalled()
  })

  it('rejects an attach that is neither a known source nor a ticket', async () => {
    const fixture = resumeFixture(LOCAL_HOST_ID, 'available')

    await expect(
      fixture.start(
        {
          ...fixture.request,
          resume: false,
          harnessSessionId: undefined,
          externalAttach: { sourceId: 'some-other-tool', key: 'x' } as never,
        },
        fixture.context,
      ),
    ).rejects.toThrow('Invalid PTY session metadata')

    expect(fixture.redeemTicket).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})
function resumeFixture(
  hostId: HostPath['hostId'],
  availability: 'available' | 'missing',
  providerId: 'claude-code' | 'codex' = 'claude-code',
  options: { readonly activeRoot?: HostPath; readonly cwd?: HostPath } = {},
) {
  const root = hostPath(hostId, '/repo')
  const cwd = options.cwd ?? root
  const activeRoot = options.activeRoot ?? root
  const template = providerTemplateProfiles().find(
    (candidate) => candidate.providerId === providerId,
  )!
  const profile =
    providerId === 'claude-code'
      ? {
          ...template,
          environment: [
            {
              kind: 'literal' as const,
              name: 'CLAUDE_CONFIG_DIR',
              value: '/config/claude',
            },
          ],
        }
      : template
  const exec = vi
    .fn<ProjectHost['exec']>()
    .mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: `${cwd.path}\n\0/config/claude`,
      stderr: '',
    })
    .mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: availability,
      stderr: '',
    })
  const defaultShell = vi.fn(() => Promise.resolve('/bin/sh'))
  const host = {
    hostId,
    connectionState: 'connected',
    watchTier: hostId === LOCAL_HOST_ID ? 'native' : 'polling',
    defaultShell,
    realpath: vi.fn((path) => Promise.resolve(path)),
    exec,
  } as unknown as ProjectHost
  const activeHost =
    activeRoot.hostId === host.hostId
      ? host
      : ({ hostId: activeRoot.hostId } as unknown as ProjectHost)
  const authorizeReattach = vi.fn(() => true)
  const authorizeResume = vi.fn(() => true)
  const authorizeFork = vi.fn(() => true)
  const authorizeReplacement = vi.fn(() => true)
  const persistRecoveryDecision = vi.fn(() => Promise.resolve())
  const recordSpawn = vi.fn(() => Promise.resolve())
  const recordReplacement = vi.fn((_replacement: RecordTerminalReplacement) =>
    Promise.resolve(),
  )
  const rebound: TerminalRecoverySession = {
    id: 'terminal-1',
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    recoverySkipCount: 0,
    harnessSessionId: HARNESS_SESSION_ID,
    hostId,
    cwd,
    title: 'Retained conversation',
    position: 0,
    active: true,
    updatedAt: 2,
  }
  const rebindProfile = vi.fn(() => Promise.resolve(rebound))
  const lease = { dispose: vi.fn(() => Promise.resolve()), release: vi.fn() }
  const register = vi.fn(
    (_owner: unknown, _qualifier: unknown, _dispose: () => unknown, _options?: unknown) =>
      lease,
  )
  const probeCapabilities = harnessProvider(
    profile.providerId,
  ).probe.effectiveCapabilities(providerId === 'codex' ? 'codex-cli 0.146.0' : '1.0.0')
  const managedCapabilities = harnessLaunchCapabilities(
    harnessProvider(profile.providerId),
    { profile, composerSubmitMode: 'enter', probedCapabilities: probeCapabilities },
  )
  const managed = {
    id: 'terminal-1',
    ownerId: 7,
    ownerGeneration: 1,
    hostId,
    cwd,
    workspaceRoot: root,
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    providerContractVersion: profile.providerContractVersion,
    composerSubmitMode: 'enter' as const,
    pid: 4321,
    startedAt: 1,
    resumed: true,
    harnessSessionId: HARNESS_SESSION_ID,
    identityStatus: 'identified' as const,
    capabilities: managedCapabilities,
  }
  const effectiveLaunchCapabilities = vi.fn(() => managedCapabilities)
  const spawn = vi.fn(
    (request: {
      sessionId: string
      resume: boolean
      composerSubmitMode: 'enter' | 'ctrl-enter'
      effectiveCapabilities: typeof managedCapabilities
    }) =>
      Promise.resolve(
        request.resume
          ? { ...managed, composerSubmitMode: request.composerSubmitMode }
          : {
              ...managed,
              id: request.sessionId,
              resumed: false,
              harnessSessionId: request.sessionId,
              composerSubmitMode: request.composerSubmitMode,
              capabilities: request.effectiveCapabilities,
            },
      ),
  )
  const handlers = new Map<
    string,
    (request: unknown, context: IpcInvokeContext) => unknown
  >()
  const projectState = terminalProjectState(activeRoot, root, cwd)
  const authority = new IpcAuthority({
    getProject: () => ({ root: activeRoot, host: activeHost }),
    getProjectState: () => projectState,
    getRegisteredWorkspaceRoot: (candidate) =>
      [activeRoot, root, cwd].find((registered) =>
        hostPathEquals(registered, candidate),
      ),
  })
  const ipc = {
    authority,
    handle: (
      channel: string,
      handler: (request: unknown, context: IpcInvokeContext) => unknown,
    ) => handlers.set(channel, handler),
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  const attach = vi.fn(
    (
      _id: string,
      _ownerId: number,
      _handlers: {
        onData?: (data: string) => void
        onExit?: (exit: { exitCode: number; signal?: number }) => void
      },
      _ownerGeneration?: number,
    ) =>
      () =>
        undefined,
  )
  const hasTransferredResource = vi.fn(() => false)
  const disposeResource = vi.fn(() => Promise.resolve(true))
  const claimTransferredResource = vi.fn(() => lease)
  const get = vi.fn<
    () => (typeof managed & Pick<ManagedPty, 'identityDiverged'>) | undefined
  >(() => undefined)
  const invalidateProbe = vi.fn()
  const probeProfiles = vi.fn()
  const refreshProfile = vi.fn()
  const recordSuccessfulLaunch = vi.fn()
  const redeemTicket = vi.fn((_owner: unknown, ticket: string) =>
    ticket === TICKET ? { sourceId: 'gas-city' as const, key: 'mem-worker-1' } : undefined,
  )
  const getHost = vi.fn((candidateHostId: string) =>
    candidateHostId === host.hostId ? host : undefined,
  )
  const deps = {
    getProject: () => ({ root: activeRoot, host: activeHost }),
    getHost,
    terminalSessions: {
      authorizeReattach,
      authorizeResume,
      authorizeFork,
      authorizeReplacement,
      recordRecoveryDecision: persistRecoveryDecision,
      recordSpawn,
      recordReplacement,
      rebindProfile,
    },
    harnessProfiles: {
      get: () => profile,
      hasPathGrant: () => false,
    },
    harnessProbes: {
      effectiveLaunchCapabilities,
      resolveLaunchCapabilities: effectiveLaunchCapabilities,
      invalidate: invalidateProbe,
      probeProfiles,
      refreshProfile,
      recordSuccessfulLaunch,
    },
    rendererResources: {
      register,
      hasTransferredResource,
      claimTransferredResource,
      disposeResource,
      assertCurrent: vi.fn(),
      isCurrent: vi.fn(() => true),
    },
    ptySupervisor: {
      spawn,
      attach,
      get,
      isAwaitingRendererAttachment: vi.fn(() => true),
      transferRendererSession: vi.fn(() => true),
      disposeSession: vi.fn(),
    },
    terminalMoves: {
      plan: vi.fn(),
      move: vi.fn(),
    },
    sessionsAttachTickets: { redeem: redeemTicket },
  } as unknown as Parameters<typeof registerTerminalIpc>[1]
  registerTerminalIpc(ipc, deps)
  const start = handlers.get('pty:start') as (
    request: StartPtyRequest,
    context: IpcInvokeContext,
  ) => Promise<StartPtyResponse>
  const recordRecoveryDecision = handlers.get('terminal:record-recovery-decision') as (
    request: {
      root: HostPath
      restoredIds: readonly string[]
      skippedIds: readonly string[]
    },
    context: IpcInvokeContext,
  ) => Promise<void>
  const rebind = handlers.get('terminal:rebind-profile') as (
    request: RebindTerminalProfileRequest,
    context: IpcInvokeContext,
  ) => Promise<TerminalRecoverySession>
  const request: StartPtyRequest = {
    sessionId: 'terminal-1',
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    workspaceRoot: root,
    cwd,
    cols: 80,
    rows: 24,
    title: 'Retained conversation',
    position: 0,
    active: true,
    composerSubmitMode: 'enter',
    resume: true,
    harnessSessionId: HARNESS_SESSION_ID,
  }
  const send = vi.fn()
  const context = {
    owner: () => ({ id: 7, generation: 1 }),
    authority: ipc.authority,
    sender: {
      isDestroyed: () => false,
      mainFrame: {
        isDestroyed: () => false,
        postMessage: send,
      },
    },
  } as unknown as IpcInvokeContext
  return {
    root,
    cwd,
    host,
    getHost,
    profile,
    exec,
    defaultShell,
    authorizeReattach,
    authorizeResume,
    authorizeFork,
    authorizeReplacement,
    recordSpawn,
    recordReplacement,
    rebound,
    rebindProfile,
    persistRecoveryDecision,
    lease,
    register,
    hasTransferredResource,
    claimTransferredResource,
    disposeResource,
    spawn,
    attach,
    get,
    managed,
    invalidateProbe,
    probeProfiles,
    refreshProfile,
    recordSuccessfulLaunch,
    redeemTicket,
    effectiveLaunchCapabilities,
    send,
    start,
    recordRecoveryDecision,
    rebind,
    request,
    context,
  }
}

function terminalProjectState(
  activeRoot: HostPath,
  targetRoot: HostPath,
  targetCwd: HostPath,
): ProjectState {
  const targetIsFocusedProject = hostPathEquals(activeRoot, targetRoot)
  const projects = [
    terminalProject(
      'focused-project',
      activeRoot,
      targetIsFocusedProject ? [activeRoot, targetCwd] : [activeRoot],
    ),
    ...(targetIsFocusedProject
      ? []
      : [terminalProject('target-project', targetRoot, [targetRoot, targetCwd])]),
  ]
  return {
    revision: 1,
    root: activeRoot,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'focused-project',
    activeWorkspaceId: 'focused-project-workspace-0',
    projects,
  }
}

function terminalProject(
  id: string,
  root: HostPath,
  workspaceRoots: readonly HostPath[],
): ProjectState['projects'][number] {
  return {
    id,
    registeredRoot: root,
    displayName: id,
    connectionState: 'connected',
    watchTier: root.hostId === LOCAL_HOST_ID ? 'native' : 'polling',
    activeWorkspaceId: `${id}-workspace-0`,
    workspaces: workspaceRoots
      .filter(
        (candidate, index) =>
          workspaceRoots.findIndex((root) => hostPathEquals(root, candidate)) === index,
      )
      .map((workspaceRoot, index) => ({
        id: `${id}-workspace-${index}`,
        root: workspaceRoot,
        name: id,
        main: index === 0,
        closed: false,
        missing: false,
        repository: true,
        changedFiles: 0,
      })),
  }
}
