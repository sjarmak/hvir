import { describe, expect, it } from 'vitest'

import {
  EMPTY_COMPANION_PAGE,
  applyCompanionTerminal,
  beginCompanionSelection,
  clearCompanionSelection,
  companionMirrorEndMessage,
  selectCompanionRow,
  type CompanionPageState,
} from '../src/renderer/companion/src/companion-store'
import {
  SESSIONS_COMPANION_VERSION,
  SESSIONS_TRANSCRIPT_VERSION,
  asSessionsTerminalHandle,
  type CompanionMirrorEndReason,
  type CompanionSnapshot,
  type SessionsTranscriptSnapshot,
} from '../src/shared'

const ROW = asSessionsTerminalHandle('row-1')
const OTHER = asSessionsTerminalHandle('row-2')
const SNAPSHOT: CompanionSnapshot = {
  version: SESSIONS_COMPANION_VERSION,
  revision: 1,
  demandGeneration: 1,
  away: false,
  rows: [],
}
const TRANSCRIPT: SessionsTranscriptSnapshot = {
  version: SESSIONS_TRANSCRIPT_VERSION,
  demandGeneration: 1,
  revision: 1,
  handle: ROW,
  status: 'ready',
  stream: 'live',
  turns: [],
  older: false,
  dropped: 0,
}

describe('Companion page state for a mirror', () => {
  it('begins a selection before the reply and clears the previous transcript and terminal', () => {
    const previous: CompanionPageState = {
      snapshot: SNAPSHOT,
      selected: OTHER,
      transcript: { ...TRANSCRIPT, handle: OTHER },
      terminal: { handle: OTHER, status: 'live', cols: 80, rows: 24 },
    }
    expect(beginCompanionSelection(previous, ROW)).toEqual({
      snapshot: SNAPSHOT,
      selected: ROW,
    })
  })

  it('applies terminal events for the selected row only and keeps output out of state', () => {
    const selected = beginCompanionSelection({ snapshot: SNAPSHOT }, ROW)
    expect(
      applyCompanionTerminal(selected, {
        type: 'opened',
        handle: OTHER,
        cols: 1,
        rows: 1,
        tail: '',
      }),
    ).toBe(selected)
    const live = applyCompanionTerminal(selected, {
      type: 'opened',
      handle: ROW,
      cols: 120,
      rows: 40,
      tail: 'x',
    })
    expect(live.terminal).toEqual({ handle: ROW, status: 'live', cols: 120, rows: 40 })
    expect(applyCompanionTerminal(live, { type: 'output', handle: ROW, data: 'y' })).toBe(
      live,
    )
    const resized = applyCompanionTerminal(live, {
      type: 'geometry',
      handle: ROW,
      cols: 100,
      rows: 30,
    })
    expect(resized.terminal).toEqual({ handle: ROW, status: 'live', cols: 100, rows: 30 })
    const ended = applyCompanionTerminal(resized, {
      type: 'ended',
      handle: ROW,
      reason: 'overrun',
    })
    expect(ended.terminal).toEqual({ handle: ROW, status: 'ended', reason: 'overrun' })
    expect(
      applyCompanionTerminal(ended, { type: 'geometry', handle: ROW, cols: 1, rows: 1 }),
    ).toBe(ended)
  })

  it('keeps the terminal when the select reply lands and drops it on back', () => {
    const live = applyCompanionTerminal(
      beginCompanionSelection(EMPTY_COMPANION_PAGE, ROW),
      {
        type: 'opened',
        handle: ROW,
        cols: 80,
        rows: 24,
        tail: '',
      },
    )
    const withTranscript = selectCompanionRow(live, TRANSCRIPT)
    expect(withTranscript.terminal).toEqual(live.terminal)
    expect(withTranscript.transcript).toBe(TRANSCRIPT)
    expect(clearCompanionSelection(withTranscript)).toEqual({ snapshot: undefined })
  })

  it('names every mirror end with a plain sentence', () => {
    const reasons: CompanionMirrorEndReason[] = [
      'exited',
      'released',
      'reselected',
      'page-closed',
      'revoked',
      'shutdown',
      'lease-lost',
      'overrun',
    ]
    for (const reason of reasons) {
      const message = companionMirrorEndMessage(reason)
      expect(message, reason).not.toContain(reason)
      expect(message.endsWith('.'), reason).toBe(true)
    }
    expect(companionMirrorEndMessage('exited')).toBe('The terminal ended.')
    expect(companionMirrorEndMessage('reselected')).toBe('Another row was selected.')
    expect(companionMirrorEndMessage('overrun')).toBe(
      'The phone fell behind; select the row again.',
    )
  })
})
