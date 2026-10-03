import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

import { sameSessionTarget } from '../src/renderer/src/sessions/sessions-overview-target'
import {
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
} from '../src/shared'
import type { SessionsProjectionRow } from '../src/shared'

function row(livePty: SessionsProjectionRow['livePty']): SessionsProjectionRow {
  return {
    handle: asSessionsTerminalHandle('terminal-1'),
    project: { id: 'project-1', name: 'Project' },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace-1'),
      name: 'main',
      qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    },
    livePty,
  } as SessionsProjectionRow
}

describe('SessionsOverview incoming target identity', () => {
  const matches: (left: SessionsProjectionRow, right: SessionsProjectionRow) => boolean =
    sameSessionTarget

  it('matches equivalent live PTY qualifiers from a fresh IPC object', () => {
    const livePty = {
      handle: asSessionsPtyHandle('pty-1'),
      rendererOwnerId: 3,
      rendererGeneration: 4,
    }
    expect(matches(row(livePty), row({ ...livePty }))).toBe(true)
  })

  it('rejects a live PTY with a different renderer generation', () => {
    const livePty = {
      handle: asSessionsPtyHandle('pty-1'),
      rendererOwnerId: 3,
      rendererGeneration: 4,
    }
    expect(matches(row(livePty), row({ ...livePty, rendererGeneration: 5 }))).toBe(false)
  })

  it('preserves serialized identity but rejects changes to every live qualifier', () =>
    hegel.test((tc) => {
      const value = tc.draw(gs.integers({ minValue: 1, maxValue: 1000000 }))
      const livePty = {
        handle: asSessionsPtyHandle(`pty-${value}`),
        rendererOwnerId: value,
        rendererGeneration: value,
      }
      const original = row(livePty)
      expect(matches(original, structuredClone(original))).toBe(true)
      const changed = [
        { ...livePty, handle: asSessionsPtyHandle(`pty-${value + 1}`) },
        { ...livePty, rendererOwnerId: value + 1 },
        { ...livePty, rendererGeneration: value + 1 },
      ]
      for (const qualifier of changed) {
        expect(matches(original, row(qualifier))).toBe(false)
        expect(matches(row(qualifier), original)).toBe(false)
      }
      expect(matches(original, row(undefined))).toBe(false)
      expect(matches(row(undefined), original)).toBe(false)
    }))
})
