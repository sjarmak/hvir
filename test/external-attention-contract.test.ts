import { describe, expect, it } from 'vitest'

import {
  EMPTY_EXTERNAL_ATTENTION,
  EXTERNAL_ATTENTION_VERSION,
  MAX_EXTERNAL_ATTENTION_ENTRIES,
  MAX_EXTERNAL_ATTENTION_WAITING,
  isExternalAttentionSnapshot,
} from '../src/shared'

describe('external attention contract', () => {
  it('accepts a current snapshot and a stale one with its reason', () => {
    expect(isExternalAttentionSnapshot(EMPTY_EXTERNAL_ATTENTION)).toBe(true)
    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: 7,
        entries: [
          { workspaceId: 'ws-1', waiting: 2 },
          { workspaceId: 'ws-2', waiting: 1, stale: true, reason: 'unreachable' },
        ],
      }),
    ).toBe(true)
  })

  it('rejects a stale entry with no reason, and a reason with no stale flag', () => {
    // Both directions are the failure ADR-048 names: a badge that cannot say
    // why it is stale is asserting a pending state nobody is watching.
    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: 1,
        entries: [{ workspaceId: 'ws-1', waiting: 1, stale: true }],
      }),
    ).toBe(false)
    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: 1,
        entries: [{ workspaceId: 'ws-1', waiting: 1, reason: 'timeout' }],
      }),
    ).toBe(false)
  })

  it('rejects a reason outside the vocabulary', () => {
    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: 1,
        entries: [
          { workspaceId: 'ws-1', waiting: 1, stale: true, reason: 'supervisor said no' },
        ],
      }),
    ).toBe(false)
  })

  it('rejects another version, an unknown key, and a bad revision', () => {
    expect(isExternalAttentionSnapshot({ version: 2, revision: 0, entries: [] })).toBe(
      false,
    )
    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: 0,
        entries: [],
        total: 3,
      }),
    ).toBe(false)
    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: -1,
        entries: [],
      }),
    ).toBe(false)
  })

  it('rejects an entry with no workspace, a fractional count, or a count past the cap', () => {
    const entry = (fields: Record<string, unknown>): unknown => ({
      version: EXTERNAL_ATTENTION_VERSION,
      revision: 0,
      entries: [{ workspaceId: 'ws-1', waiting: 1, ...fields }],
    })

    expect(isExternalAttentionSnapshot(entry({ workspaceId: '' }))).toBe(false)
    expect(isExternalAttentionSnapshot(entry({ waiting: 1.5 }))).toBe(false)
    expect(isExternalAttentionSnapshot(entry({ waiting: -1 }))).toBe(false)
    expect(
      isExternalAttentionSnapshot(entry({ waiting: MAX_EXTERNAL_ATTENTION_WAITING + 1 })),
    ).toBe(false)
  })

  it('rejects more entries than the cap allows', () => {
    const entries = Array.from(
      { length: MAX_EXTERNAL_ATTENTION_ENTRIES + 1 },
      (_, index) => ({ workspaceId: `ws-${index}`, waiting: 1 }),
    )

    expect(
      isExternalAttentionSnapshot({
        version: EXTERNAL_ATTENTION_VERSION,
        revision: 0,
        entries,
      }),
    ).toBe(false)
  })

  it('rejects a value that is not a snapshot at all', () => {
    for (const candidate of [undefined, null, 'snapshot', 3, []]) {
      expect(isExternalAttentionSnapshot(candidate)).toBe(false)
    }
  })
})
