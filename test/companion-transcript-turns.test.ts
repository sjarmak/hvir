import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import { newestTranscriptTurns } from '../src/renderer/companion/src/companion-transcript-turns'
import type { SessionsTranscriptTurn } from '../src/shared'

describe('Companion transcript turns', () => {
  it('renders the newest turn first without changing ordinals', () => {
    const turns = [turn(2), turn(4), turn(9)]

    expect(newestTranscriptTurns(turns).map((entry) => entry.ordinal)).toEqual([9, 4, 2])
    expect(turns.map((entry) => entry.ordinal)).toEqual([2, 4, 9])
  })

  it('reverses every generated ordered transcript without mutating it', () =>
    hegel.test((testCase) => {
      const ordinals = testCase.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 1_000 }), { maxSize: 50 }),
      )
      const turns = [...new Set(ordinals)]
        .sort((left, right) => left - right)
        .map(turn)
      const before = turns.map((entry) => entry.ordinal)

      expect(newestTranscriptTurns(turns).map((entry) => entry.ordinal)).toEqual(
        [...before].reverse(),
      )
      expect(turns.map((entry) => entry.ordinal)).toEqual(before)
    }))
})

function turn(ordinal: number): SessionsTranscriptTurn {
  return { ordinal, role: 'assistant', kind: 'text', text: `turn ${ordinal}` }
}
