import { describe, expect, it } from 'vitest'

import { terminalStartRequest } from '../src/renderer/src/terminal/terminal-runtime-launch'
import { asHarnessProfileId, localPath } from '../src/shared'

const options = {
  commandTicket: 'command-ticket',
  commandWorkspaceId: 'workspace-id',
  externalAttach: { ticket: 'external-ticket' },
  profileId: asHarnessProfileId('codex-default'),
  launchRevision: 1,
  workspaceRoot: localPath('/repo'),
  cwd: localPath('/repo'),
  position: 0,
  active: true,
  composerSubmitMode: 'enter',
  startMode: 'interactive',
} as const

describe('terminalStartRequest', () => {
  it('keeps declaring an external attach after a failed initial launch', () => {
    const request = terminalStartRequest(
      options,
      'session-id',
      undefined,
      { cols: 80, rows: 24 },
      'Terminal',
      false,
      false,
      true,
    )

    expect(request.commandTicket).toBeUndefined()
    expect(request.externalAttach).toEqual({ ticket: 'external-ticket' })
  })

  it('does not redeclare an attach when only the command ticket is on its first start', () => {
    const request = terminalStartRequest(
      options,
      'session-id',
      undefined,
      { cols: 80, rows: 24 },
      'Terminal',
      false,
      true,
      false,
    )

    expect(request.commandTicket).toBe('command-ticket')
    expect(request.externalAttach).toBeUndefined()
  })
})
