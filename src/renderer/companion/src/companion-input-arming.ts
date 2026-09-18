/**
 * Whether the phone may type into the mirrored terminal right now (ADR-050).
 * A mirror opens disarmed; the person arms it, each key they send extends the
 * arming, and it lapses on its own after an idle bound. Hiding the page and
 * the mirror ending disarm it from outside, through `disarmInput`.
 */
export const COMPANION_INPUT_ARM_IDLE_MS = 120_000

export type CompanionInputArming =
  { readonly armed: false } | { readonly armed: true; readonly until: number }

const DISARMED: CompanionInputArming = { armed: false }

export function armInput(now: number): CompanionInputArming {
  return { armed: true, until: now + COMPANION_INPUT_ARM_IDLE_MS }
}

export function touchInput(
  state: CompanionInputArming,
  now: number,
): CompanionInputArming {
  return state.armed ? armInput(now) : state
}

export function disarmInput(): CompanionInputArming {
  return DISARMED
}

/** The state after the clock reads `now`: unchanged, or disarmed once `until` passed. */
export function inputArmingAfterTick(
  state: CompanionInputArming,
  now: number,
): CompanionInputArming {
  return state.armed && now >= state.until ? DISARMED : state
}
