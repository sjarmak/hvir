/**
 * A Companion world built on the real Sessions ports and fake sources: the
 * observation port over fake session, PTY, project and city sources, the
 * transcript port over a fake supervisor client, the actionable set, and the
 * one companion sink registry. Tests count listeners on the fake sources to
 * prove the Companion is quiet when no page is open.
 */
import { ActionableAttentionSet } from '../src/main/attention/actionable-attention-set'
import type { HostCityEvents } from '../src/main/gascity/city-event-facts'
import type { HostCitySessions } from '../src/main/gascity/gascity-city-sessions'
import type {
  PendingInteraction,
  SessionRespondInputBody,
  SessionSubmitInputBody,
} from '../src/main/gascity/generated-supervisor-api'
import type { SessionTranscriptStructuredResponse } from '../src/main/gascity/generated-supervisor-transcript'
import type { SupervisorAccess } from '../src/main/gascity/supervisor-access'
import type {
  GascitySupervisorClient,
  SupervisorStreamSubscribers,
  SupervisorStreamSubscription,
} from '../src/main/gascity/supervisor-client'
import type { ObservedManagedPty } from '../src/main/pty/pty-supervisor'
import { SessionsCompanionSinkRegistry } from '../src/main/sessions/sessions-companion-sinks'
import {
  dispatchDemandOwner,
  type SessionsDemandOwner,
} from '../src/main/sessions/sessions-demand-owner'
import { SessionsObservationPort } from '../src/main/sessions/sessions-observation-port'
import { SessionsTranscriptPort } from '../src/main/sessions/sessions-transcript-port'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  hostPath,
  localPath,
  type ProjectState,
} from '../src/shared'
import { fakeMirrors } from './companion-mirror-fixture'

export const codex = asHarnessProviderId('codex')
export const codexProfile = asHarnessProfileId('codex-default')
export const localRoot = localPath('/private/repo')
export const sshRoot = hostPath(asHostId('ssh-prod'), '/secret/remote/repo')

export interface FakeStream {
  readonly afterCursor: string | undefined
  readonly subscribers: SupervisorStreamSubscribers
  closed: boolean
}

export interface CompanionWorldOptions {
  readonly pending?: () => PendingInteraction | undefined
}

export function companionWorld(options: CompanionWorldOptions = {}) {
  const sessions = observationSource<OwnedTerminalSession>([
    retained('local-session', localRoot, 'Local Codex'),
    retained('remote-session', sshRoot, 'Remote Codex'),
  ])
  const ptys = observationSource<ObservedManagedPty>([])
  const projects = listeners()
  const cities = observationSource<HostCitySessions>([cityFacts()])
  const events = observationSource<HostCityEvents>([cityEventFacts()])
  const missing: string[] = []
  const rendererEmits: SessionsDemandOwner[] = []
  const sinks = new SessionsCompanionSinkRegistry((channel) => {
    missing.push(channel)
  })
  const route = (owner: SessionsDemandOwner, deliver: () => void): void =>
    dispatchDemandOwner(owner, {
      renderer: () => {
        rendererEmits.push(owner)
      },
      companion: deliver,
    })
  const observation = new SessionsObservationPort({
    projectState,
    hosts: hostOptions,
    providers,
    sessions,
    ptys,
    observeProjects: projects.observe,
    emit: (owner, change) =>
      route(owner, () => {
        if (owner.kind === 'companion') sinks.projection(owner, change)
      }),
    cities,
    events,
  })
  const supervisor = fakeSupervisor(options)
  const transcripts = new SessionsTranscriptPort({
    sessions: observation,
    supervisor: supervisor.access,
    emit: (owner, change) =>
      route(owner, () => {
        if (owner.kind === 'companion') sinks.transcript(owner, change)
      }),
  })
  const actionable = new ActionableAttentionSet()
  const mirrors = fakeMirrors()
  let actionableListeners = 0
  const countedActionable: Pick<ActionableAttentionSet, 'snapshot' | 'observe'> = {
    snapshot: () => actionable.snapshot(),
    observe: (listener) => {
      actionableListeners += 1
      const stop = actionable.observe(listener)
      return () => {
        actionableListeners -= 1
        stop()
      }
    },
  }
  return {
    sessions,
    ptys,
    projects,
    cities,
    events,
    observation,
    transcripts,
    actionable,
    sinks,
    mirrors,
    missing,
    rendererEmits,
    streams: supervisor.streams,
    responded: supervisor.responded,
    submitted: supervisor.submitted,
    actionableListeners: () => actionableListeners,
    ports: {
      observation,
      transcripts,
      actionable: countedActionable,
      sinks,
      mirrors: mirrors.ports,
    },
    settle: async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    },
  }
}

function fakeSupervisor(options: CompanionWorldOptions) {
  const streams: FakeStream[] = []
  const responded: SessionRespondInputBody[] = []
  const submitted: SessionSubmitInputBody[] = []
  const client = {
    transcript: () => Promise.resolve({ ok: true as const, value: transcriptResponse() }),
    sessionPending: () => {
      const pending = options.pending?.()
      return Promise.resolve({
        ok: true as const,
        value: { supported: true, ...(pending === undefined ? {} : { pending }) },
      })
    },
    respond: (_city: string, _session: string, body: SessionRespondInputBody) => {
      responded.push(body)
      return Promise.resolve({ ok: true as const, value: { id: 'gc-1', status: 'ok' } })
    },
    submit: (_city: string, _session: string, body: SessionSubmitInputBody) => {
      submitted.push(body)
      return Promise.resolve({
        ok: true as const,
        value: { event_cursor: '0', request_id: 'req-9', status: 'accepted' },
      })
    },
    streamSession: (
      _city: string,
      _session: string,
      subscribers: SupervisorStreamSubscribers,
      afterCursor?: string,
    ): Promise<SupervisorStreamSubscription> => {
      const stream: FakeStream = { afterCursor, subscribers, closed: false }
      streams.push(stream)
      return Promise.resolve({
        close: () => {
          stream.closed = true
        },
        get cursor() {
          return afterCursor
        },
      })
    },
  } as unknown as GascitySupervisorClient
  const access: SupervisorAccess = {
    address: () => Promise.resolve({ ok: true, value: { client, cityName: 'gastown' } }),
  }
  return { access, streams, responded, submitted }
}

export function interaction(
  overrides: Partial<PendingInteraction> = {},
): PendingInteraction {
  return {
    kind: 'tool-approval',
    request_id: 'req-1',
    prompt: 'Run the migration against production?',
    options: ['allow', 'deny'],
    ...overrides,
  }
}

function transcriptResponse(): SessionTranscriptStructuredResponse {
  return {
    format: 'structured',
    history: {
      continuity: { status: 'continuous' },
      cursor: { resume_token: 'resume-1' },
      generation: { id: 'gen-1' },
      tail_state: { activity: 'idle' },
      transcript_stream_id: 'stream-1',
    },
    id: 'gc-1',
    operation: 'snapshot',
    provider: 'claude',
    schema_version: 'session.structured.v1',
    structured_messages: [
      {
        id: 'm1',
        role: 'user',
        status: 'final',
        blocks: [{ type: 'text', text: 'ship the panel' }],
      },
    ],
    template: 'structured',
  }
}

function projectState(): ProjectState {
  const localProjectId = `project:${localRoot.hostId}:${localRoot.path}`
  const localWorkspaceId = `workspace:${localRoot.hostId}:${localRoot.path}`
  const sshProjectId = `project:${sshRoot.hostId}:${sshRoot.path}`
  const sshWorkspaceId = `workspace:${sshRoot.hostId}:${sshRoot.path}`
  return {
    revision: 1,
    root: localRoot,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: localProjectId,
    activeWorkspaceId: localWorkspaceId,
    projects: [
      {
        id: localProjectId,
        registeredRoot: localRoot,
        displayName: 'Local project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: localWorkspaceId,
        workspaces: [workspace(localWorkspaceId, localRoot, 'main')],
      },
      {
        id: sshProjectId,
        registeredRoot: sshRoot,
        displayName: 'Remote project',
        connectionState: 'disconnected',
        watchTier: 'polling',
        activeWorkspaceId: sshWorkspaceId,
        workspaces: [workspace(sshWorkspaceId, sshRoot, 'remote-main')],
      },
    ],
  }
}

function workspace(id: string, root: typeof localRoot, name: string) {
  return {
    id,
    root,
    name,
    main: true,
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
    {
      hostId: 'ssh-prod',
      label: 'Production',
      kind: 'ssh' as const,
      connectionState: 'disconnected' as const,
      watchTier: 'polling' as const,
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
  ]
}

export function retained(
  id: string,
  root: typeof localRoot,
  title: string,
): OwnedTerminalSession {
  return {
    id,
    providerId: codex,
    profileId: codexProfile,
    launchRevision: 1,
    recoverySkipCount: 0,
    artifactIdentity: '0123456789abcdef01234567',
    harnessSessionId: 'provider-session-secret',
    hostId: root.hostId,
    workspaceRoot: root,
    cwd: root,
    title,
    position: 0,
    active: true,
    updatedAt: 1,
  }
}

/** A live PTY under a retained session id; `livePty.handle` becomes `pty-instance-<id>`. */
export function livePty(id: string, root: typeof localRoot): ObservedManagedPty {
  return {
    info: {
      instanceId: `pty-instance-${id}`,
      id,
      ownerId: 7,
      ownerGeneration: 4,
      hostId: root.hostId,
      cwd: root,
      workspaceRoot: root,
      providerId: codex,
      capabilities: {
        sessionIdentity: 'discovered',
        exactResume: true,
        contextPresentation: 'pressure',
      },
      profileId: codexProfile,
      pid: 123,
      startedAt: 1,
      resumed: false,
      harnessSessionId: 'provider-session-secret',
      identityStatus: 'identified',
    },
  }
}

function observationSource<T>(initial: readonly T[]) {
  let snapshot = initial
  const observed = listeners()
  return {
    observationSnapshot: () => snapshot,
    observe: observed.observe,
    listenerCount: observed.listenerCount,
    set: (next: readonly T[]) => {
      snapshot = next
      observed.publish()
    },
  }
}

function listeners() {
  const values = new Set<() => void>()
  return {
    observe: (listener: () => void) => {
      values.add(listener)
      return () => {
        values.delete(listener)
      }
    },
    publish: () => {
      for (const listener of values) listener()
    },
    listenerCount: () => values.size,
  }
}

function cityFacts(): HostCitySessions {
  return {
    root: localRoot,
    cityRoot: localPath('/private/city'),
    observedAt: 1_700_000_000_000,
    staleAfterMs: 3_000,
    stale: false,
    sessions: [citySession('gc-1', 'city-worker'), citySession('gc-2', 'city-scout')],
  }
}

function citySession(
  sessionKey: string,
  label: string,
): HostCitySessions['sessions'][number] {
  return {
    sessionKey,
    label,
    tier: 'worker',
    attachTarget: label,
    rigRoot: localRoot,
    workDir: localRoot,
    state: 'active',
    activity: 'active',
  }
}

function cityEventFacts(): HostCityEvents {
  return {
    hostId: localRoot.hostId,
    stream: 'live',
    observedAt: 1_700_000_000_000,
    lifecycle: [],
    pending: [],
  }
}
