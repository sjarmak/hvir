import { describe, expect, it } from 'vitest'

import type { ActionableSnapshot } from '../src/main/attention/actionable-attention-set'
import {
  AWAY_IDLE_THRESHOLD_MS,
  AWAY_READY_SLACK_MS,
  AWAY_WINDOW_STATES,
  awayAppearanceViolations,
  awayReadyBudgetMs,
  formatAwayReadyMeasurement,
  judgeAwayReadyMeasurement,
  parseAwayHiddenHoldMs,
  type AwayReadyMeasurement,
} from '../src/main/smoke/attention-away-policy'

const measurement: AwayReadyMeasurement = {
  state: 'hidden',
  honored: true,
  quietToReadyMs: 4_210,
  holdMs: 1_000,
  visibility: 'hidden',
  rendererFocused: false,
  minimized: false,
  away: true,
}

function snapshot(
  revision: number,
  away: boolean,
  keys: readonly string[],
): ActionableSnapshot {
  return {
    revision,
    away,
    entries: keys.map((key) => ({ key, kind: 'ready', freshness: 'fresh' })),
    working: [],
  }
}

describe('away Ready budget', () => {
  it('allows the renderer quiet period plus the ADR-049 verification slack', () => {
    expect(AWAY_IDLE_THRESHOLD_MS).toBe(4_000)
    expect(AWAY_READY_SLACK_MS).toBe(2_000)
    expect(awayReadyBudgetMs()).toBe(6_000)
  })

  it('measures every window state the desk can be away in, in order', () => {
    expect(AWAY_WINDOW_STATES).toEqual(['visible-unfocused', 'hidden', 'minimized'])
  })

  it('accepts a Ready inside the budget and names the overrun otherwise', () => {
    expect(judgeAwayReadyMeasurement(measurement)).toBeUndefined()
    expect(
      judgeAwayReadyMeasurement({ ...measurement, quietToReadyMs: 6_000 }),
    ).toBeUndefined()
    expect(judgeAwayReadyMeasurement({ ...measurement, quietToReadyMs: 6_001 })).toBe(
      'hidden: Ready reached main 6001ms after the terminal went quiet (budget 6000ms)',
    )
  })

  it('rejects a Ready that main saw while a window was focused', () => {
    expect(judgeAwayReadyMeasurement({ ...measurement, away: false })).toBe(
      'hidden: Ready reached main while a window was focused',
    )
  })
})

describe('away appearance rule', () => {
  it('flags an entry that appears while some window is focused', () => {
    const violations = awayAppearanceViolations(
      [
        snapshot(1, false, []),
        snapshot(2, false, ['pty-1']),
        snapshot(3, true, ['pty-1']),
      ],
      'pty-1',
    )
    expect(violations).toEqual([2])
  })

  it('accepts an entry that appears while away and stays through a refocus', () => {
    expect(
      awayAppearanceViolations(
        [
          snapshot(1, false, []),
          snapshot(2, true, []),
          snapshot(3, true, ['pty-1']),
          snapshot(4, false, ['pty-1']),
          snapshot(5, false, []),
          snapshot(6, true, []),
          snapshot(7, true, ['pty-1']),
        ],
        'pty-1',
      ),
    ).toEqual([])
  })

  it('ignores other terminals', () => {
    expect(
      awayAppearanceViolations(
        [snapshot(1, false, []), snapshot(2, false, ['pty-2'])],
        'pty-1',
      ),
    ).toEqual([])
  })
})

describe('hidden hold knob', () => {
  it('defaults to the one second every state waits before the burst', () => {
    expect(parseAwayHiddenHoldMs(undefined)).toBe(1_000)
    expect(parseAwayHiddenHoldMs('')).toBe(1_000)
  })

  it('accepts a longer hold so a long-hidden window can be measured once', () => {
    expect(parseAwayHiddenHoldMs('320000')).toBe(320_000)
    expect(parseAwayHiddenHoldMs('500')).toBe(1_000)
  })

  it.each(['abc', '-1', '1.5', '3600001'])('rejects %s', (value) => {
    expect(() => parseAwayHiddenHoldMs(value)).toThrow(
      'HVIR_SMOKE_AWAY_HIDDEN_HOLD_MS must be an ASCII decimal integer from 0 through 3600000',
    )
  })
})

describe('measurement line', () => {
  it('prints the numbers an operator reads into the responsiveness record', () => {
    expect(formatAwayReadyMeasurement(measurement)).toBe(
      'hidden: quiet->ready 4210ms (hold 1000ms, visibility hidden, renderer focused false, minimized false, away true, state honored)',
    )
    expect(
      formatAwayReadyMeasurement({ ...measurement, state: 'minimized', honored: false }),
    ).toBe(
      'minimized: quiet->ready 4210ms (hold 1000ms, visibility hidden, renderer focused false, minimized false, away true, state not honored by the display, blurred instead)',
    )
  })
})
