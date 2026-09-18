/**
 * What the Away Ready-detection smoke measures and how it judges the result
 * (ADR-049 Consequences: away-time correctness depends on a hidden renderer
 * still classifying Ready on time, verified under background throttling).
 */

import {
  appearances,
  type ActionableSnapshot,
} from '../attention/actionable-attention-set'

/** The renderer's default Ready quiet period (src/renderer/src/settings/settings.ts). */
export const AWAY_IDLE_THRESHOLD_MS = 4_000
/** Slack the verification allows over the quiet period for throttled timers and IPC. */
export const AWAY_READY_SLACK_MS = 2_000
/** The terminal stays silent this long after the window changes state, then bursts. */
export const AWAY_DEFAULT_HOLD_MS = 1_000
/**
 * A prompt has no quiet period (ADR-051): the notification is the signal, so
 * the whole allowance is for a throttled renderer and IPC to carry it to main.
 */
export const AWAY_PROMPT_BUDGET_MS = 5_000
const AWAY_MAX_HIDDEN_HOLD_MS = 3_600_000
const HIDDEN_HOLD_VARIABLE = 'HVIR_SMOKE_AWAY_HIDDEN_HOLD_MS'

/** Every way the desk can be away, in the order the scenario measures them. */
export const AWAY_WINDOW_STATES = ['visible-unfocused', 'hidden', 'minimized'] as const
export type AwayWindowState = (typeof AWAY_WINDOW_STATES)[number]

export interface AwayReadyMeasurement {
  readonly state: AwayWindowState
  /** The display reached the requested state; false when it only blurred. */
  readonly honored: boolean
  /** Last PTY output seen by main to the Ready entry reaching main's set. */
  readonly quietToReadyMs: number
  readonly holdMs: number
  readonly visibility: string
  readonly rendererFocused: boolean
  readonly minimized: boolean
  /** main's away predicate when the Ready entry appeared. */
  readonly away: boolean
}

export function awayReadyBudgetMs(): number {
  return AWAY_IDLE_THRESHOLD_MS + AWAY_READY_SLACK_MS
}

/** The failure a measurement proves, or nothing when Ready arrived on time while away. */
export function judgeAwayReadyMeasurement(
  measurement: AwayReadyMeasurement,
): string | undefined {
  if (!measurement.away) {
    return `${measurement.state}: Ready reached main while a window was focused`
  }
  const budget = awayReadyBudgetMs()
  if (measurement.quietToReadyMs > budget) {
    return `${measurement.state}: Ready reached main ${measurement.quietToReadyMs}ms after the terminal went quiet (budget ${budget}ms)`
  }
  return undefined
}

/**
 * Revisions at which `key` entered the set while some window was focused.
 * Such an appearance would be push-worthy by timing but not by predicate, so
 * the scenario requires none (ADR-049: Push fires only while Away).
 */
export function awayAppearanceViolations(
  snapshots: readonly ActionableSnapshot[],
  key: string,
): readonly number[] {
  const violations: number[] = []
  snapshots.forEach((next, index) => {
    if (index === 0 || next.away) return
    const appeared = appearances(snapshots[index - 1]!, next)
    if (appeared.some((entry) => entry.key === key)) violations.push(next.revision)
  })
  return violations
}

/** How long the hidden window stays hidden before its burst; one knob for a long-hidden run. */
export function parseAwayHiddenHoldMs(value: string | undefined): number {
  if (value === undefined || value === '') return AWAY_DEFAULT_HOLD_MS
  const holdMs = Number(value)
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(holdMs) ||
    holdMs > AWAY_MAX_HIDDEN_HOLD_MS
  ) {
    throw new Error(
      `${HIDDEN_HOLD_VARIABLE} must be an ASCII decimal integer from 0 through ${AWAY_MAX_HIDDEN_HOLD_MS}; received ${JSON.stringify(value)}`,
    )
  }
  return Math.max(holdMs, AWAY_DEFAULT_HOLD_MS)
}

export function formatAwayReadyMeasurement(measurement: AwayReadyMeasurement): string {
  const honored = measurement.honored
    ? 'state honored'
    : 'state not honored by the display, blurred instead'
  return (
    `${measurement.state}: quiet->ready ${measurement.quietToReadyMs}ms ` +
    `(hold ${measurement.holdMs}ms, visibility ${measurement.visibility}, ` +
    `renderer focused ${measurement.rendererFocused}, minimized ${measurement.minimized}, ` +
    `away ${measurement.away}, ${honored})`
  )
}
