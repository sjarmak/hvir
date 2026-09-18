import { describe, expect, it } from 'vitest'

import {
  MAX_COMPANION_ROWS,
  MAX_SESSIONS_SUBMIT_MESSAGE,
  SESSIONS_COMPANION_VERSION,
  compareCompanionRows,
  isCompanionRespondRequest,
  isCompanionRow,
  isCompanionSnapshot,
  isCompanionSubmitRequest,
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
