/**
 * The phone's mirror text size (ADR-059). The size decides the cell, the cell
 * decides the grid the page holds the PTY at (ADR-058), so what this module
 * has to get right is that every number it hands on is one of the ladder's
 * steps, whatever a device's storage answers with.
 */
import { describe, expect, it } from 'vitest'

import {
  COMPANION_DEFAULT_TEXT_SIZE,
  COMPANION_TEXT_SIZES,
  nearestTextSize,
  readCompanionTextSize,
  stepCompanionTextSize,
  writeCompanionTextSize,
} from '../src/renderer/companion/src/companion-text-size'

function storage(initial?: string): {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  read(): string | undefined
} {
  let held = initial
  return {
    getItem: () => held ?? null,
    setItem: (_key, value) => {
      held = value
    },
    read: () => held,
  }
}

describe('Companion mirror text size', () => {
  it('starts well under the desktop-readable size, which is what more session visible means', () => {
    expect(COMPANION_DEFAULT_TEXT_SIZE).toBeLessThan(15)
    expect(COMPANION_TEXT_SIZES).toContain(COMPANION_DEFAULT_TEXT_SIZE)
    // A phone's 376px of width at this size holds about sixty columns rather
    // than about forty, which is the whole point of the record.
    expect(Math.floor(376 / (COMPANION_DEFAULT_TEXT_SIZE * 0.6))).toBeGreaterThan(55)
  })

  it('steps one place and stops at each end of the ladder', () => {
    const smallest = COMPANION_TEXT_SIZES[0]!
    const largest = COMPANION_TEXT_SIZES.at(-1)!
    expect(stepCompanionTextSize(smallest, -1)).toBe(smallest)
    expect(stepCompanionTextSize(largest, 1)).toBe(largest)
    expect(stepCompanionTextSize(10, -1)).toBe(9)
    expect(stepCompanionTextSize(10, 1)).toBe(11)
    // A size off the ladder steps from the step nearest it rather than nowhere.
    expect(stepCompanionTextSize(13.6, 1)).toBe(15)
  })

  it('remembers the choice and reads back the step it stored', () => {
    const device = storage()
    writeCompanionTextSize(device, 8)
    expect(device.read()).toBe('8')
    expect(readCompanionTextSize(device)).toBe(8)
  })

  it('takes the default from a device that has stored nothing or stored nonsense', () => {
    expect(readCompanionTextSize(storage())).toBe(COMPANION_DEFAULT_TEXT_SIZE)
    expect(readCompanionTextSize(storage('enormous'))).toBe(COMPANION_DEFAULT_TEXT_SIZE)
    expect(readCompanionTextSize(storage('0'))).toBe(COMPANION_DEFAULT_TEXT_SIZE)
    expect(readCompanionTextSize(storage('-4'))).toBe(COMPANION_DEFAULT_TEXT_SIZE)
    // A size from some later ladder is the nearest step this one has.
    expect(readCompanionTextSize(storage('13.6'))).toBe(13)
    expect(nearestTextSize(200)).toBe(COMPANION_TEXT_SIZES.at(-1))
  })

  it('answers the default rather than throwing where storage itself refuses', () => {
    const refusing = {
      getItem: () => {
        throw new Error('storage is disabled')
      },
      setItem: () => {
        throw new Error('storage is disabled')
      },
    }
    expect(readCompanionTextSize(refusing)).toBe(COMPANION_DEFAULT_TEXT_SIZE)
    expect(() => writeCompanionTextSize(refusing, 9)).not.toThrow()
  })
})
