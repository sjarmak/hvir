import { describe, expect, it } from 'vitest'

import { companionRows } from '../src/main/companion/companion-rows'
import type { MainActionableEntry } from '../src/main/attention/actionable-attention-set'
import type { SessionsExternalSessionKey } from '../src/main/sessions/sessions-projection-identities'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  isCompanionSnapshot,
  sessionsWorkspaceQualifier,
  type SessionsObservedSession,
  type SessionsTerminalHandle,
  type SessionsWorkspaceProjection,
} from '../src/shared'

const LOCAL_WORKSPACE = asSessionsWorkspaceHandle('sessions-workspace-1')
const REMOTE_WORKSPACE = asSessionsWorkspaceHandle('sessions-workspace-2')
const TERMINAL = asSessionsTerminalHandle('terminal-1')
const EXTERNAL = asSessionsTerminalHandle('sessions-external-0001')
const EXTERNAL_KEY: SessionsExternalSessionKey = {
  sourceId: 'gas-city',
  hostId: asHostId('ssh-prod'),
  key: 'gc-1',
}

describe('companion rows', () => {
  it('takes a terminal row attention from the entry with the same handle', () => {
    const rows = companionRows({
      observation: observation([terminal(TERMINAL, 'Codex')]),
      working: [],
      actionable: [entry({ key: TERMINAL, kind: 'bell', terminalHandle: TERMINAL })],
      resolveExternal: () => undefined,
    })

    expect(rows).toEqual([
      {
        handle: TERMINAL,
        title: 'Codex',
        project: { handle: 'sessions-project-1', name: 'Local project' },
        workspace: {
          handle: LOCAL_WORKSPACE,
          name: 'main',
          hostLabel: 'Local',
          hostKind: 'local',
        },
        origin: { kind: 'hvir-terminal' },
        attention: { status: 'available', value: 'bell' },
        freshness: 'fresh',
        working: false,
        turn: { status: 'available', value: { state: 'working' } },
        canAnswer: false,
        canMirror: false,
      },
    ])
  })

  it('marks a row working when the set names its handle, and no other row', () => {
    const rows = companionRows({
      observation: observation([
        terminal(TERMINAL, 'Codex'),
        terminal(asSessionsTerminalHandle('terminal-2'), 'Quiet'),
      ]),
      working: [TERMINAL],
      actionable: [],
      resolveExternal: () => undefined,
    })

    expect(rows.map((row) => [row.handle, row.working])).toEqual([
      [TERMINAL, true],
      ['terminal-2', false],
    ])
    expect(
      isCompanionSnapshot({ version: 1, revision: 1, demandGeneration: 1, rows }),
    ).toBe(true)
  })

  it('carries a prompt entry as prompt attention with its body (ADR-051)', () => {
    const rows = companionRows({
      observation: observation([terminal(TERMINAL, 'Codex')]),
      working: [],
      actionable: [
        entry({
          key: TERMINAL,
          kind: 'prompt',
          terminalHandle: TERMINAL,
          body: 'Claude needs your permission',
        }),
      ],
      resolveExternal: () => undefined,
    })

    expect(rows[0]).toMatchObject({
      attention: { status: 'available', value: 'prompt' },
      promptBody: 'Claude needs your permission',
    })
    expect(
      isCompanionSnapshot({ version: 1, revision: 1, demandGeneration: 1, rows }),
    ).toBe(true)
  })

  it('drops the body of a prompt entry whose attention is no longer an available prompt', () => {
    const rows = companionRows({
      observation: observation([terminal(TERMINAL, 'Codex')]),
      working: [],
      actionable: [
        entry({
          key: TERMINAL,
          kind: 'prompt',
          terminalHandle: TERMINAL,
          freshness: 'stale',
          reason: 'closed',
          body: 'Claude needs your permission',
        }),
      ],
      resolveExternal: () => undefined,
    })

    expect(rows[0]?.attention).toEqual({ status: 'unavailable', reason: 'source-stale' })
    expect(rows[0]).not.toHaveProperty('promptBody')
    expect(
      isCompanionSnapshot({ version: 1, revision: 1, demandGeneration: 1, rows }),
    ).toBe(true)
  })

  it('carries no promptBody for a prompt entry without one', () => {
    const rows = companionRows({
      observation: observation([terminal(TERMINAL, 'Codex')]),
      working: [],
      actionable: [entry({ key: TERMINAL, kind: 'prompt', terminalHandle: TERMINAL })],
      resolveExternal: () => undefined,
    })

    expect(rows[0]?.attention).toEqual({ status: 'available', value: 'prompt' })
    expect(rows[0]).not.toHaveProperty('promptBody')
  })

  it('canMirror follows companionMirrorEligible', () => {
    const rows = companionRows({
      observation: observation([
        { ...terminal(TERMINAL, 'Codex'), livePty: livePtyQualifier() },
        {
          ...terminal(asSessionsTerminalHandle('terminal-2'), 'Remote'),
          workspaceId: REMOTE_WORKSPACE,
          livePty: livePtyQualifier(),
        },
        {
          ...terminal(asSessionsTerminalHandle('terminal-3'), 'Retained'),
          lifecycle: 'retained',
        },
      ]),
      working: [],
      actionable: [],
      resolveExternal: () => undefined,
    })
    expect(rows.map((row) => [row.handle, row.canMirror])).toEqual([
      [TERMINAL, true],
      ['terminal-3', false],
      ['terminal-2', false],
    ])
  })

  it('takes an external row attention from the entry its resolver names', () => {
    const rows = companionRows({
      observation: observation([external(EXTERNAL, 'city-worker', 1_700)]),
      working: [],
      actionable: [entry({ key: 'gas-city ssh-prod gc-1', external: EXTERNAL_KEY })],
      resolveExternal: (handle) => (handle === EXTERNAL ? EXTERNAL_KEY : undefined),
    })

    expect(rows[0]).toMatchObject({
      handle: EXTERNAL,
      origin: { kind: 'external-agent', sourceId: 'gas-city', sourceName: 'Gas City' },
      workspace: { name: 'remote-main', hostLabel: 'Production', hostKind: 'ssh' },
      attention: { status: 'available', value: 'ready', observedAt: 1_700 },
      freshness: 'fresh',
      canAnswer: true,
    })
    expect(rows[0]).not.toHaveProperty('reason')
  })

  it('carries a stale entry as stale attention with the reason it was given', () => {
    const rows = companionRows({
      observation: observation([external(EXTERNAL, 'city-worker', 1_700)]),
      working: [],
      actionable: [
        entry({
          key: 'gas-city ssh-prod gc-1',
          external: EXTERNAL_KEY,
          freshness: 'stale',
          reason: 'unreachable',
        }),
      ],
      resolveExternal: () => EXTERNAL_KEY,
    })

    expect(rows[0]).toMatchObject({
      attention: {
        status: 'stale',
        value: 'ready',
        observedAt: 1_700,
        reason: 'source-stale',
      },
      freshness: 'stale',
      reason: 'unreachable',
    })
  })

  it('reports a stale entry it cannot date as unavailable rather than dating it', () => {
    const rows = companionRows({
      observation: observation([terminal(TERMINAL, 'Codex')]),
      working: [],
      actionable: [
        entry({
          key: TERMINAL,
          terminalHandle: TERMINAL,
          freshness: 'stale',
          reason: 'closed',
        }),
      ],
      resolveExternal: () => undefined,
    })

    expect(rows[0]).toMatchObject({
      attention: { status: 'unavailable', reason: 'source-stale' },
      freshness: 'stale',
      reason: 'closed',
    })
  })

  it('reports a row the actionable set does not name as unsupported', () => {
    const rows = companionRows({
      observation: observation([
        terminal(TERMINAL, 'Codex'),
        external(EXTERNAL, 'city-worker', 1_700),
      ]),
      working: [],
      actionable: [],
      resolveExternal: () => EXTERNAL_KEY,
    })

    // The projection itself said the external row is waiting; the Companion
    // still reports what the badge reports, so the two cannot disagree.
    expect(rows.map((row) => row.attention)).toEqual([
      { status: 'unsupported' },
      { status: 'unsupported' },
    ])
    expect(rows.map((row) => row.freshness)).toEqual(['fresh', 'fresh'])
  })

  it('orders fresh actionable, then stale actionable, then project, workspace, title, handle', () => {
    const a = asSessionsTerminalHandle('terminal-a')
    const b = asSessionsTerminalHandle('terminal-b')
    const c = asSessionsTerminalHandle('terminal-c')
    const d = asSessionsTerminalHandle('terminal-d')
    const rows = companionRows({
      observation: observation([
        terminal(d, 'Zed'),
        terminal(c, 'Alpha'),
        terminal(b, 'Beta'),
        terminal(a, 'Alpha'),
        external(EXTERNAL, 'city-worker', 1_700),
      ]),
      working: [],
      actionable: [
        entry({ key: b, terminalHandle: b, freshness: 'stale', reason: 'closed' }),
        entry({ key: 'gas-city ssh-prod gc-1', external: EXTERNAL_KEY }),
        entry({ key: d, terminalHandle: d, kind: 'bell' }),
      ],
      resolveExternal: (handle) => (handle === EXTERNAL ? EXTERNAL_KEY : undefined),
    })

    expect(rows.map((row) => row.handle)).toEqual([d, EXTERNAL, b, a, c])
  })

  it('drops a session whose workspace is not projected', () => {
    const orphan: SessionsObservedSession = {
      ...terminal(TERMINAL, 'Codex'),
      workspaceId: asSessionsWorkspaceHandle('sessions-workspace-9'),
    }

    expect(
      companionRows({
        observation: observation([orphan]),
        working: [],
        actionable: [],
        resolveExternal: () => undefined,
      }),
    ).toEqual([])
  })

  it('lets nothing main owns through, and produces a snapshot the guard accepts', () => {
    const rows = companionRows({
      observation: observation([
        { ...terminal(TERMINAL, 'Codex'), livePty: livePtyQualifier() },
        external(EXTERNAL, 'city-worker', 1_700),
      ]),
      working: [],
      actionable: [
        entry({ key: TERMINAL, terminalHandle: TERMINAL }),
        entry({ key: 'gas-city ssh-prod gc-1', external: EXTERNAL_KEY }),
      ],
      resolveExternal: () => EXTERNAL_KEY,
    })
    const serialized = JSON.stringify(rows)

    for (const secret of [
      'gc-1',
      'ssh-prod',
      '/private/',
      '/secret/',
      'requestId',
      'req-1',
      'livePty',
      'qualifier',
      'rendererOwnerId',
      'sessionKey',
      'cityRoot',
      '1:0:0',
    ]) {
      expect(serialized, secret).not.toContain(secret)
    }
    expect(
      isCompanionSnapshot({ version: 1, revision: 1, demandGeneration: 1, rows }),
    ).toBe(true)
  })
})

function observation(sessions: readonly SessionsObservedSession[]) {
  return { workspaces: [localWorkspace(), remoteWorkspace()], sessions }
}

function localWorkspace(): SessionsWorkspaceProjection {
  return {
    projectId: asSessionsProjectHandle('sessions-project-1'),
    projectName: 'Local project',
    workspaceId: LOCAL_WORKSPACE,
    qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    workspaceName: 'main',
    main: true,
    closed: false,
    missing: false,
    host: { id: 'local', label: 'Local', kind: 'local', connectionState: 'connected' },
  }
}

function remoteWorkspace(): SessionsWorkspaceProjection {
  return {
    projectId: asSessionsProjectHandle('sessions-project-2'),
    projectName: 'Remote project',
    workspaceId: REMOTE_WORKSPACE,
    qualifier: sessionsWorkspaceQualifier(1, 1, 0),
    workspaceName: 'remote-main',
    main: true,
    closed: false,
    missing: false,
    host: {
      id: 'ssh-prod',
      label: 'Production',
      kind: 'ssh',
      connectionState: 'disconnected',
    },
  }
}

function terminal(
  handle: SessionsTerminalHandle,
  title: string,
): SessionsObservedSession {
  return {
    handle,
    workspaceId: LOCAL_WORKSPACE,
    origin: { kind: 'hvir-terminal' },
    providerId: asHarnessProviderId('codex'),
    profile: { status: 'available', value: { id: asHarnessProfileId('codex-default') } },
    title,
    lifecycle: 'live',
    telemetry: {
      model: { status: 'available', value: { id: 'gpt-safe' } },
      context: { status: 'unsupported' },
      turn: { status: 'available', value: { state: 'working' } },
      freshness: { status: 'unsupported' },
    },
  }
}

function external(
  handle: SessionsTerminalHandle,
  title: string,
  observedAt: number,
): SessionsObservedSession {
  return {
    handle,
    workspaceId: REMOTE_WORKSPACE,
    origin: { kind: 'external-agent', sourceId: 'gas-city', sourceName: 'Gas City' },
    providerId: asHarnessProviderId('codex'),
    profile: { status: 'unsupported' },
    title,
    lifecycle: 'retained',
    telemetry: {
      model: { status: 'unsupported' },
      context: { status: 'unsupported' },
      turn: { status: 'available', value: { state: 'waiting-for-approval' } },
      freshness: { status: 'unsupported' },
    },
    attention: { status: 'available', value: 'ready', observedAt },
  }
}

function livePtyQualifier() {
  return {
    handle: asSessionsPtyHandle('pty-instance-terminal-1'),
    rendererOwnerId: 7,
    rendererGeneration: 4,
  }
}

function entry(
  fields: Partial<MainActionableEntry> & Pick<MainActionableEntry, 'key'>,
): MainActionableEntry {
  return { kind: 'ready', freshness: 'fresh', ...fields }
}
