import { describe, expect, it } from 'vitest'

import { createSmokeAttention } from '../src/main/smoke/attention-smoke'
import { asSessionsTerminalHandle } from '../src/shared'

describe('smoke attention wiring', () => {
  it('records what windows send and what the badge would show, without a desktop', () => {
    const attention = createSmokeAttention()
    const owner = { id: 3, generation: 1 }
    const set = {
      version: 1 as const,
      entries: [
        {
          handle: asSessionsTerminalHandle('t1'),
          kind: 'ready' as const,
          freshness: 'fresh' as const,
        },
      ],
    }

    attention.setOwnerFocused(owner, false)
    attention.updateAttention(owner, set)

    expect(attention.updates).toEqual([{ owner, set }])
    expect(attention.badgeCounts).toEqual([0, 1])
    expect(attention.set.snapshot().entries.map((entry) => entry.key)).toEqual(['t1'])

    attention.dispose()
    expect(attention.badgeCounts.at(-1)).toBe(0)
    expect(attention.set.snapshot().entries).toEqual([])
  })
})
