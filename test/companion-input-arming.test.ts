import { describe, expect, it } from 'vitest'

import {
  COMPANION_INPUT_ARM_IDLE_MS,
  armInput,
  disarmInput,
  inputArmingAfterTick,
  touchInput,
} from '../src/renderer/companion/src/companion-input-arming'

describe('Companion input arming', () => {
  it('starts disarmed', () => {
    expect(disarmInput()).toEqual({ armed: false })
  })

  it('arm sets until = now + idle bound', () => {
    expect(armInput(1_000)).toEqual({
      armed: true,
      until: 1_000 + COMPANION_INPUT_ARM_IDLE_MS,
    })
  })

  it('touch extends an armed state and leaves a disarmed one alone', () => {
    const armed = armInput(1_000)
    expect(touchInput(armed, 5_000)).toEqual({
      armed: true,
      until: 5_000 + COMPANION_INPUT_ARM_IDLE_MS,
    })
    expect(touchInput(disarmInput(), 5_000)).toEqual({ armed: false })
  })

  it('tick past until disarms and before it keeps the same state', () => {
    const armed = armInput(1_000)
    expect(inputArmingAfterTick(armed, 1_000 + COMPANION_INPUT_ARM_IDLE_MS - 1)).toBe(
      armed,
    )
    expect(inputArmingAfterTick(armed, 1_000 + COMPANION_INPUT_ARM_IDLE_MS)).toEqual({
      armed: false,
    })
    const disarmed = disarmInput()
    expect(inputArmingAfterTick(disarmed, 9_999_999)).toBe(disarmed)
  })

  it('disarm is idempotent', () => {
    expect(disarmInput()).toEqual(disarmInput())
  })
})
