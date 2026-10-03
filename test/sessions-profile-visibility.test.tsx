import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionsOverviewCard } from '../src/renderer/src/sessions/SessionsOverviewCard'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  SESSIONS_HVIR_ORIGIN,
  sessionsWorkspaceQualifier,
  type SessionsProjectionRow,
} from '../src/shared'

describe('SessionsOverviewCard profile visibility', () => {
  it('renders the hvir launch profile as a card fact', () => {
    const markup = renderToStaticMarkup(
      <SessionsOverviewCard row={row()} group="workspace" opening={false} />,
    )

    expect(markup).toContain('<dt>Profile</dt><dd>Omni Dev</dd>')
  })
})

function row(): SessionsProjectionRow {
  const unavailable = { status: 'unsupported' as const }
  return {
    handle: asSessionsTerminalHandle('profiled'),
    origin: SESSIONS_HVIR_ORIGIN,
    project: {
      id: asSessionsProjectHandle('project-one'),
      name: 'Project One',
    },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace-main'),
      name: 'main',
      main: true,
      qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    },
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local',
      connectionState: 'connected',
    },
    provider: {
      id: asHarnessProviderId('codex'),
      name: 'Codex',
      kind: 'agent',
    },
    profile: {
      status: 'available',
      value: { id: asHarnessProfileId('omni-profile'), displayName: 'Omni Dev' },
    },
    title: 'Profiled session',
    lifecycle: 'live',
    connectionState: 'connected',
    attention: { status: 'available', value: 'none' },
    working: { status: 'available', value: false },
    model: unavailable,
    context: unavailable,
    turn: unavailable,
    telemetryFreshness: unavailable,
    usage: { status: 'unsupported' },
  }
}
