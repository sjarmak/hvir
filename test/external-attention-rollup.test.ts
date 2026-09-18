import { describe, expect, it } from 'vitest'

import { EXTERNAL_ATTENTION_VERSION, type ExternalAttentionSnapshot } from '../src/shared'
import {
  aggregateExternalAttention,
  externalAttentionByWorkspace,
  externalAttentionLabel,
  workspaceExternalAttention,
} from '../src/renderer/src/workspaces/external-attention'

describe('external attention rollup', () => {
  it('rolls workspaces up to a project the way terminal attention does', () => {
    const attention = byWorkspace([
      { workspaceId: 'ws-1', waiting: 2 },
      { workspaceId: 'ws-2', waiting: 1 },
      { workspaceId: 'ws-9', waiting: 5 },
    ])

    expect(aggregateExternalAttention(['ws-1', 'ws-2'], attention)).toEqual({
      waiting: 3,
      stale: false,
    })
    expect(workspaceExternalAttention('ws-2', attention)).toEqual({
      waiting: 1,
      stale: false,
    })
    // A workspace with nothing waiting is zero, not undefined.
    expect(workspaceExternalAttention('ws-absent', attention)).toEqual({
      waiting: 0,
      stale: false,
    })
  })

  it('carries staleness and one reason up to the project', () => {
    const attention = byWorkspace([
      { workspaceId: 'ws-1', waiting: 2 },
      { workspaceId: 'ws-2', waiting: 1, stale: true, reason: 'unreachable' },
    ])

    expect(aggregateExternalAttention(['ws-1', 'ws-2'], attention)).toEqual({
      waiting: 3,
      stale: true,
      reason: 'unreachable',
    })
  })

  it('says how many agents are waiting, and why a count is stale', () => {
    expect(externalAttentionLabel({ waiting: 1, stale: false })).toBe(
      '1 agent waiting on you',
    )
    expect(externalAttentionLabel({ waiting: 2, stale: false })).toBe(
      '2 agents waiting on you',
    )
    expect(
      externalAttentionLabel({ waiting: 2, stale: true, reason: 'unreachable' }),
    ).toBe('2 agents waiting on you · last seen before the connection was lost')
    expect(externalAttentionLabel({ waiting: 1, stale: true, reason: 'denied' })).toBe(
      '1 agent waiting on you · last seen before the connection was refused',
    )
  })

  it('never shows a raw reason code to a person', () => {
    const reasons = [
      'disabled',
      'misconfigured',
      'unreachable',
      'timeout',
      'aborted',
      'protocol',
      'not-found',
      'denied',
      'conflict',
      'rejected',
      'unsupported',
      'unready',
      'faulted',
      'city-unknown',
      'closed',
    ] as const

    for (const reason of reasons) {
      const label = externalAttentionLabel({ waiting: 1, stale: true, reason })
      expect(label).not.toContain(reason === 'closed' ? 'city-unknown' : reason)
    }
  })

  it('keeps the newest entry when a snapshot names a workspace twice', () => {
    const attention = byWorkspace([
      { workspaceId: 'ws-1', waiting: 1 },
      { workspaceId: 'ws-1', waiting: 3 },
    ])

    expect(workspaceExternalAttention('ws-1', attention).waiting).toBe(3)
  })
})

function byWorkspace(entries: ExternalAttentionSnapshot['entries']) {
  return externalAttentionByWorkspace({
    version: EXTERNAL_ATTENTION_VERSION,
    revision: 1,
    entries,
  })
}
