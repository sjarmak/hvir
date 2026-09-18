import { describe, expect, it } from 'vitest'

import { PTY_OUTPUT_TAIL_CHARS } from '../src/main/pty/pty-output-tail'
import {
  MAX_ACTIONABLE_BODY_CHARS,
  MAX_COMPANION_INPUT_CHARS,
  MAX_COMPANION_ROWS,
  MAX_COMPANION_TERMINAL_TAIL_CHARS,
  MAX_SESSIONS_SUBMIT_MESSAGE,
  SESSIONS_COMPANION_VERSION,
  compareCompanionRows,
  isCompanionInputRequest,
  isCompanionRespondRequest,
  isCompanionRow,
  isCompanionSnapshot,
  isCompanionSubmitRequest,
  isCompanionTerminalEvent,
  type CompanionRow,
} from '../src/shared'

const row = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  handle: 'terminal-1',
  title: 'Codex',
  project: { handle: 'sessions-project-1', name: 'Local project' },
  workspace: {
    handle: 'sessions-workspace-1',
    name: 'main',
    hostLabel: 'Local',
    hostKind: 'local',
  },
  origin: { kind: 'hvir-terminal' },
  attention: { status: 'available', value: 'ready' },
  freshness: 'fresh',
  turn: { status: 'unsupported' },
  canAnswer: false,
  canMirror: false,
  ...fields,
})

const snapshot = (rows: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  version: SESSIONS_COMPANION_VERSION,
  revision: 0,
  demandGeneration: 1,
  rows,
  ...extra,
})

describe('sessions companion contract', () => {
  it('accepts an empty snapshot and a row of each origin', () => {
    expect(isCompanionSnapshot(snapshot([]))).toBe(true)
    expect(
      isCompanionSnapshot(
        snapshot([
          row(),
          row({
            handle: 'sessions-external-0001',
            origin: {
              kind: 'external-agent',
              sourceId: 'gas-city',
              sourceName: 'Gas City',
            },
            attention: {
              status: 'stale',
              value: 'ready',
              observedAt: 5,
              reason: 'source-stale',
            },
            freshness: 'stale',
            reason: 'unreachable',
            turn: { status: 'available', value: { state: 'waiting-for-approval' } },
            canAnswer: true,
          }),
        ]),
      ),
    ).toBe(true)
  })

  it('pairs a stale row with its reason, and a reason only with a stale row', () => {
    expect(isCompanionRow(row({ freshness: 'stale' }))).toBe(false)
    expect(isCompanionRow(row({ reason: 'unreachable' }))).toBe(false)
    expect(isCompanionRow(row({ freshness: 'stale', reason: 'because' }))).toBe(false)
    expect(isCompanionRow(row({ freshness: 'stale', reason: 'closed' }))).toBe(true)
  })

  it('rejects a snapshot that carries more than its shape, or the wrong version', () => {
    expect(isCompanionSnapshot(snapshot([], { activeProject: 'p' }))).toBe(false)
    expect(isCompanionSnapshot(snapshot([], { version: 2 }))).toBe(false)
    expect(isCompanionSnapshot(snapshot([], { demandGeneration: 0 }))).toBe(false)
    expect(isCompanionSnapshot(snapshot([row(), row()]))).toBe(false)
    expect(
      isCompanionSnapshot(snapshot(Array.from({ length: MAX_COMPANION_ROWS + 1 }, row))),
    ).toBe(false)
  })

  it('rejects a row that names what main keeps', () => {
    expect(isCompanionRow(row({ livePty: { handle: 'pty' } }))).toBe(false)
    expect(
      isCompanionRow(
        row({ workspace: { ...(row()['workspace'] as object), hostId: 'ssh-prod' } }),
      ),
    ).toBe(false)
    expect(
      isCompanionRow(
        row({ workspace: { ...(row()['workspace'] as object), hostKind: 'wsl' } }),
      ),
    ).toBe(false)
    expect(isCompanionRow(row({ origin: { kind: 'hvir-terminal', path: '/p' } }))).toBe(
      false,
    )
    expect(
      isCompanionRow(row({ attention: { status: 'available', value: 'urgent' } })),
    ).toBe(false)
    expect(isCompanionRow(row({ attention: { status: 'stale', value: 'ready' } }))).toBe(
      false,
    )
    expect(
      isCompanionRow(row({ turn: { status: 'available', value: { state: 'busy' } } })),
    ).toBe(false)
    expect(isCompanionRow(row({ handle: '' }))).toBe(false)
  })

  it('admits a prompt row with a bounded promptBody (ADR-051)', () => {
    const prompt = (promptBody?: unknown) =>
      row({
        attention: { status: 'available', value: 'prompt' },
        ...(promptBody === undefined ? {} : { promptBody }),
      })
    expect(isCompanionRow(prompt())).toBe(true)
    expect(isCompanionRow(prompt('Claude needs your permission'))).toBe(true)
    expect(isCompanionRow(prompt('x'.repeat(MAX_ACTIONABLE_BODY_CHARS)))).toBe(true)
    expect(isCompanionRow(prompt('x'.repeat(MAX_ACTIONABLE_BODY_CHARS + 1)))).toBe(false)
    expect(isCompanionRow(prompt(''))).toBe(false)
    expect(isCompanionRow(prompt(7))).toBe(false)
    expect(isCompanionRow(prompt(null))).toBe(false)
    expect(
      isCompanionSnapshot(snapshot([prompt('Claude needs your permission')])),
    ).toBe(true)
  })

  it('rejects a promptBody on any row whose attention is not an available prompt', () => {
    const promptBody = 'Claude needs your permission'
    expect(isCompanionRow(row({ promptBody }))).toBe(false)
    expect(
      isCompanionRow(row({ attention: { status: 'available', value: 'bell' }, promptBody })),
    ).toBe(false)
    expect(
      isCompanionRow(
        row({ attention: { status: 'unavailable', reason: 'source-stale' }, promptBody }),
      ),
    ).toBe(false)
    expect(isCompanionRow(row({ attention: { status: 'unsupported' }, promptBody }))).toBe(
      false,
    )
    expect(
      isCompanionRow(
        row({
          attention: { status: 'stale', value: 'prompt', observedAt: 5, reason: 'source-stale' },
          freshness: 'stale',
          reason: 'closed',
          promptBody,
        }),
      ),
    ).toBe(false)
    expect(
      isCompanionRow(row({ attention: { status: 'available', value: 'prompt' }, promptBody })),
    ).toBe(true)
  })

  it('rows require canMirror as a boolean', () => {
    expect(isCompanionRow(row({ canMirror: true }))).toBe(true)
    const { canMirror: _dropped, ...withoutMirror } = row()
    expect(isCompanionRow(withoutMirror)).toBe(false)
    expect(isCompanionRow(row({ canMirror: 'yes' }))).toBe(false)
  })

  it('accepts every terminal event variant and rejects extra keys', () => {
    const opened = {
      type: 'opened',
      handle: 't1',
      cols: 120,
      rows: 40,
      tail: '\u001b[2J',
    }
    const output = { type: 'output', handle: 't1', data: 'hello\r\n' }
    const geometry = { type: 'geometry', handle: 't1', cols: 80, rows: 24 }
    for (const reason of [
      'exited',
      'released',
      'reselected',
      'page-closed',
      'revoked',
      'shutdown',
      'lease-lost',
      'overrun',
    ]) {
      expect(
        isCompanionTerminalEvent({ type: 'ended', handle: 't1', reason }),
        reason,
      ).toBe(true)
    }
    for (const event of [opened, output, geometry]) {
      expect(isCompanionTerminalEvent(event), event.type).toBe(true)
      expect(isCompanionTerminalEvent({ ...event, extra: 1 }), event.type).toBe(false)
      expect(isCompanionTerminalEvent({ ...event, handle: '' }), event.type).toBe(false)
    }
    expect(isCompanionTerminalEvent({ ...opened, tail: 7 })).toBe(false)
    expect(isCompanionTerminalEvent({ ...opened, cols: 0 })).toBe(false)
    expect(isCompanionTerminalEvent({ ...geometry, rows: 1.5 })).toBe(false)
    expect(isCompanionTerminalEvent({ ...output, data: undefined })).toBe(false)
    expect(
      isCompanionTerminalEvent({ type: 'ended', handle: 't1', reason: 'bored' }),
    ).toBe(false)
    expect(
      isCompanionTerminalEvent({ type: 'resize', handle: 't1', cols: 1, rows: 1 }),
    ).toBe(false)
    expect(isCompanionTerminalEvent(null)).toBe(false)
  })

  it('bounds tail and input length', () => {
    const tail = (length: number) => ({
      type: 'opened',
      handle: 't1',
      cols: 1,
      rows: 1,
      tail: 'x'.repeat(length),
    })
    expect(isCompanionTerminalEvent(tail(MAX_COMPANION_TERMINAL_TAIL_CHARS))).toBe(true)
    expect(isCompanionTerminalEvent(tail(MAX_COMPANION_TERMINAL_TAIL_CHARS + 1))).toBe(
      false,
    )
    expect(isCompanionInputRequest({ data: '\r' })).toBe(true)
    expect(isCompanionInputRequest({ data: 'x'.repeat(MAX_COMPANION_INPUT_CHARS) })).toBe(
      true,
    )
    expect(
      isCompanionInputRequest({ data: 'x'.repeat(MAX_COMPANION_INPUT_CHARS + 1) }),
    ).toBe(false)
    expect(isCompanionInputRequest({ data: '' })).toBe(false)
    expect(isCompanionInputRequest({ data: '\r', handle: 't1' })).toBe(false)
    expect(isCompanionInputRequest({})).toBe(false)
    expect(isCompanionInputRequest('\r')).toBe(false)
  })

  it('tail bound equals PTY_OUTPUT_TAIL_CHARS', () => {
    expect(MAX_COMPANION_TERMINAL_TAIL_CHARS).toBe(PTY_OUTPUT_TAIL_CHARS)
  })

  it('accepts an answer and a message of the transcript shapes, without a generation', () => {
    expect(
      isCompanionRespondRequest({ handle: 'h', pendingRevision: 1, optionOrdinal: 0 }),
    ).toBe(true)
    expect(
      isCompanionRespondRequest({
        handle: 'h',
        pendingRevision: 1,
        optionOrdinal: 0,
        text: 'why',
      }),
    ).toBe(true)
    expect(
      isCompanionRespondRequest({
        handle: 'h',
        pendingRevision: 1,
        optionOrdinal: 0,
        demandGeneration: 1,
      }),
    ).toBe(false)
    expect(
      isCompanionRespondRequest({ handle: 'h', pendingRevision: -1, optionOrdinal: 0 }),
    ).toBe(false)
    expect(isCompanionSubmitRequest({ handle: 'h', message: 'go' })).toBe(true)
    expect(isCompanionSubmitRequest({ handle: 'h', message: 7 })).toBe(false)
    expect(
      isCompanionSubmitRequest({
        handle: 'h',
        message: 'x'.repeat(MAX_SESSIONS_SUBMIT_MESSAGE + 1),
      }),
    ).toBe(false)
    expect(isCompanionSubmitRequest({ handle: 'h', message: 'go', requestId: 'r' })).toBe(
      false,
    )
  })

  it('orders actionable rows first, fresh before stale, then like the panel', () => {
    const fresh = row({ handle: 'z', title: 'Zed' }) as unknown as CompanionRow
    const stale = row({
      handle: 'a',
      title: 'Alpha',
      freshness: 'stale',
      reason: 'closed',
      attention: {
        status: 'stale',
        value: 'bell',
        observedAt: 1,
        reason: 'source-stale',
      },
    }) as unknown as CompanionRow
    const idle = row({
      handle: 'b',
      title: 'Alpha',
      attention: { status: 'unsupported' },
    }) as unknown as CompanionRow
    const none = row({
      handle: 'c',
      title: 'Alpha',
      attention: { status: 'available', value: 'none' },
    }) as unknown as CompanionRow

    expect(
      [none, idle, stale, fresh].sort(compareCompanionRows).map((r) => r.handle),
    ).toEqual(['z', 'a', 'b', 'c'])
  })
})
