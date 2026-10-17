import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { describe, expect, it } from 'vitest'

import {
  addBusinessMs,
  AMBER_AFTER_BUSINESS_DAYS,
  BUSINESS_DAY_MS,
  businessAgeTone,
  businessMsBetween,
  formatBusinessAge,
  RED_AFTER_BUSINESS_DAYS,
} from '../src/shared'

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

const local = (year: number, month: number, day: number, hour = 0): number =>
  new Date(year, month, day, hour).getTime()

/** October 2026, local time: the 5th is a Monday, the 10th and 11th a weekend. */
const october = (day: number, hour = 0): number => local(2026, 9, day, hour)

/**
 * Fridays before the 2026 DST changes in the US and Europe. The expected spans hold in
 * every zone; in a zone that changes on that weekend they also prove the day walk lands
 * on local midnights, since a 24-hour step drifts an hour over the 23- or 25-hour Sunday.
 */
const DST_WEEKENDS: readonly (readonly [
  string,
  (hour: number, daysLater?: number) => number,
])[] = [
  ['US spring', (hour, daysLater = 0) => local(2026, 2, 6 + daysLater, hour)],
  ['European spring', (hour, daysLater = 0) => local(2026, 2, 27 + daysLater, hour)],
  ['European autumn', (hour, daysLater = 0) => local(2026, 9, 23 + daysLater, hour)],
  ['US autumn', (hour, daysLater = 0) => local(2026, 9, 30 + daysLater, hour)],
]

describe('businessMsBetween', () => {
  it.each([
    ['a span inside one weekday', october(5, 9), october(5, 17), 8 * HOUR_MS],
    ['Friday evening to Monday morning', october(9, 17), october(12, 9), 16 * HOUR_MS],
    ['a start on Saturday', october(10, 12), october(12, 6), 6 * HOUR_MS],
    ['an end on Sunday', october(9, 20), october(11, 12), 4 * HOUR_MS],
    ['a span wholly inside the weekend', october(10, 10), october(11, 10), 0],
    ['two whole weeks', october(5), october(19), 10 * BUSINESS_DAY_MS],
    [
      'Thursday noon to the Tuesday after next',
      october(8, 12),
      october(20, 12),
      8 * BUSINESS_DAY_MS,
    ],
    ['to equal to from', october(7, 12), october(7, 12), 0],
    ['to before from', october(9, 12), october(5, 12), 0],
    ...DST_WEEKENDS.map(([label, friday]): [string, number, number, number] => [
      `Friday evening to Monday morning across the ${label} change`,
      friday(17),
      friday(9, 3),
      16 * HOUR_MS,
    ]),
    [
      'a whole week across the US autumn change',
      local(2026, 9, 30),
      local(2026, 10, 6),
      5 * BUSINESS_DAY_MS,
    ],
  ])('counts %s', (_label, from, to, expected) => {
    expect(businessMsBetween(from, to)).toBe(expected)
  })

  it('never shrinks as the end moves later', () =>
    hegel.test((tc) => {
      const from = october(tc.draw(gs.integers({ minValue: 1, maxValue: 20 })))
      const earlier =
        from + tc.draw(gs.integers({ minValue: 0, maxValue: 20 * BUSINESS_DAY_MS }))
      const later =
        earlier + tc.draw(gs.integers({ minValue: 0, maxValue: 5 * BUSINESS_DAY_MS }))
      expect(businessMsBetween(from, earlier)).toBeLessThanOrEqual(
        businessMsBetween(from, later),
      )
    }))

  it('counts nothing between two instants of the same weekend', () =>
    hegel.test((tc) => {
      const from =
        october(10) + tc.draw(gs.integers({ minValue: 0, maxValue: 47 * HOUR_MS }))
      const to = from + tc.draw(gs.integers({ minValue: 0, maxValue: HOUR_MS }))
      expect(businessMsBetween(from, Math.min(to, october(12)))).toBe(0)
    }))
})

describe('addBusinessMs', () => {
  it.each([
    ['inside one weekday', october(5, 9), 8 * HOUR_MS, october(5, 17)],
    ['across the weekend', october(9, 17), 16 * HOUR_MS, october(12, 9)],
    ['from a Saturday', october(10, 12), 6 * HOUR_MS, october(12, 6)],
    [
      'two whole weeks, at the earliest instant',
      october(5),
      10 * BUSINESS_DAY_MS,
      october(17),
    ],
    ...DST_WEEKENDS.map(([label, friday]): [string, number, number, number] => [
      `across the ${label} change`,
      friday(17),
      16 * HOUR_MS,
      friday(9, 3),
    ]),
  ])('lands %s', (_label, from, ms, expected) => {
    expect(addBusinessMs(from, ms)).toBe(expected)
  })

  it('round-trips businessMsBetween', () =>
    hegel.test((tc) => {
      const from = october(
        tc.draw(gs.integers({ minValue: 1, maxValue: 14 })),
        tc.draw(gs.integers({ minValue: 0, maxValue: 23 })),
      )
      const ms = tc.draw(gs.integers({ minValue: 0, maxValue: 10 * BUSINESS_DAY_MS }))
      expect(businessMsBetween(from, addBusinessMs(from, ms))).toBe(ms)
    }))
})

describe('formatBusinessAge', () => {
  it.each([
    [0, '0m'],
    [5 * MINUTE_MS, '5m'],
    [59 * MINUTE_MS + 59_000, '59m'],
    [HOUR_MS, '1h'],
    [3 * HOUR_MS + 30 * MINUTE_MS, '3h'],
    [23 * HOUR_MS, '23h'],
    [BUSINESS_DAY_MS, '1d'],
    [2 * BUSINESS_DAY_MS + 7 * HOUR_MS, '2d'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatBusinessAge(ms)).toBe(expected)
  })
})

describe('businessAgeTone', () => {
  it.each([
    [0, 'neutral'],
    [AMBER_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS - 1, 'neutral'],
    [AMBER_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS, 'amber'],
    [RED_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS - 1, 'amber'],
    [RED_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS, 'red'],
    [10 * BUSINESS_DAY_MS, 'red'],
  ])('tones %d ms as %s', (ms, expected) => {
    expect(businessAgeTone(ms)).toBe(expected)
  })
})
