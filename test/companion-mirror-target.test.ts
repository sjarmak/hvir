import { describe, expect, it } from 'vitest'

import {
  companionMirrorEligible,
  companionMirrorTarget,
} from '../src/main/companion/companion-mirror-target'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsObservedSession,
  type SessionsWorkspaceProjection,
} from '../src/shared'

const LOCAL_WORKSPACE = asSessionsWorkspaceHandle('sessions-workspace-1')
const REMOTE_WORKSPACE = asSessionsWorkspaceHandle('sessions-workspace-2')
const TERMINAL = asSessionsTerminalHandle('terminal-1')
const EXTERNAL = asSessionsTerminalHandle('sessions-external-0001')

describe('companion mirror target', () => {
  it('resolves a live connected hvir row to its pty id and instance id', () => {
    const observation = {
      workspaces: [workspace(LOCAL_WORKSPACE, 'connected')],
      sessions: [live(TERMINAL, LOCAL_WORKSPACE)],
    }
    expect(companionMirrorTarget(observation, TERMINAL)).toEqual({
      ptyId: 'terminal-1',
      instanceId: 'pty-instance-terminal-1',
    })
    expect(companionMirrorTarget(observation, EXTERNAL)).toBeUndefined()
  })

  it('refuses retained rows, disconnected hosts, closed workspaces, and rows without livePty', () => {
    const connected = workspace(LOCAL_WORKSPACE, 'connected')
    expect(companionMirrorEligible(live(TERMINAL, LOCAL_WORKSPACE), connected)).toBe(true)
    expect(
      companionMirrorEligible(
        { ...live(TERMINAL, LOCAL_WORKSPACE), lifecycle: 'retained' },
        connected,
      ),
    ).toBe(false)
    expect(
      companionMirrorEligible(
        live(TERMINAL, REMOTE_WORKSPACE),
        workspace(REMOTE_WORKSPACE, 'disconnected'),
      ),
    ).toBe(false)
    expect(
      companionMirrorEligible(live(TERMINAL, LOCAL_WORKSPACE), {
        ...connected,
        closed: true,
      }),
    ).toBe(false)
    expect(
      companionMirrorEligible(live(TERMINAL, LOCAL_WORKSPACE), {
        ...connected,
        missing: true,
      }),
    ).toBe(false)
    const { livePty: _dropped, ...withoutPty } = live(TERMINAL, LOCAL_WORKSPACE)
    expect(companionMirrorEligible(withoutPty, connected)).toBe(false)
    expect(
      companionMirrorTarget(
        { workspaces: [connected], sessions: [withoutPty] },
        TERMINAL,
      ),
    ).toBeUndefined()
    expect(
      companionMirrorTarget(
        { workspaces: [], sessions: [live(TERMINAL, LOCAL_WORKSPACE)] },
        TERMINAL,
      ),
    ).toBeUndefined()
  })

  it('an external row attached inside an hvir terminal is eligible', () => {
    const attached: SessionsObservedSession = {
      ...live(TERMINAL, LOCAL_WORKSPACE),
      origin: { kind: 'external-agent', sourceId: 'gas-city', sourceName: 'Gas City' },
    }
    expect(
      companionMirrorEligible(attached, workspace(LOCAL_WORKSPACE, 'connected')),
    ).toBe(true)
  })
})

function workspace(
  id: SessionsWorkspaceProjection['workspaceId'],
  connectionState: SessionsWorkspaceProjection['host']['connectionState'],
): SessionsWorkspaceProjection {
  return {
    projectId: asSessionsProjectHandle('sessions-project-1'),
    projectName: 'Local project',
    workspaceId: id,
    qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    workspaceName: 'main',
    main: true,
    closed: false,
    missing: false,
    host: { id: 'local', label: 'Local', kind: 'local', connectionState },
  }
}

function live(
  handle: SessionsObservedSession['handle'],
  workspaceId: SessionsWorkspaceProjection['workspaceId'],
): SessionsObservedSession {
  return {
    handle,
    workspaceId,
    origin: { kind: 'hvir-terminal' },
    providerId: asHarnessProviderId('codex'),
    profile: { status: 'available', value: { id: asHarnessProfileId('codex-default') } },
    title: 'Codex',
    lifecycle: 'live',
    livePty: {
      handle: asSessionsPtyHandle(`pty-instance-${handle}`),
      rendererOwnerId: 7,
      rendererGeneration: 4,
    },
    telemetry: {
      model: { status: 'unsupported' },
      context: { status: 'unsupported' },
      turn: { status: 'unsupported' },
      freshness: { status: 'unsupported' },
    },
  }
}
