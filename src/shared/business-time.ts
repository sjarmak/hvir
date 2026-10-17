/**
 * Business time (ADR-976): elapsed milliseconds that skip Saturdays and Sundays in the
 * local timezone. Days are walked between local midnights, so a DST day counts its real
 * 23 or 25 hours. Holidays are not skipped.
 */

export const BUSINESS_DAY_MS = 86_400_000
export const AMBER_AFTER_BUSINESS_DAYS = 1
export const RED_AFTER_BUSINESS_DAYS = 3

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

export type BusinessAgeTone = 'neutral' | 'amber' | 'red'

function isWeekend(ms: number): boolean {
  const day = new Date(ms).getDay()
  return day === 0 || day === 6
}

function nextLocalMidnight(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
}

/** Business milliseconds from `from` to `to` (epoch ms); 0 when `to` is not later. */
export function businessMsBetween(from: number, to: number): number {
  let total = 0
  let cursor = from
  while (cursor < to) {
    const dayEnd = Math.min(nextLocalMidnight(cursor), to)
    total += isWeekend(cursor) ? 0 : dayEnd - cursor
    cursor = dayEnd
  }
  return total
}

/**
 * The earliest instant `ms` of business time after `from`; the inverse of
 * businessMsBetween. A whole number of business days from a Monday midnight lands on the
 * following Saturday midnight, not the Monday after.
 */
export function addBusinessMs(from: number, ms: number): number {
  let remaining = ms
  let cursor = from
  for (;;) {
    const dayEnd = nextLocalMidnight(cursor)
    if (!isWeekend(cursor)) {
      const available = dayEnd - cursor
      if (remaining <= available) return cursor + remaining
      remaining -= available
    }
    cursor = dayEnd
  }
}

/** Minutes under an hour, hours under a business day, otherwise whole business days. */
export function formatBusinessAge(ms: number): string {
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`
  if (ms < BUSINESS_DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`
  return `${Math.floor(ms / BUSINESS_DAY_MS)}d`
}

export function businessAgeTone(ms: number): BusinessAgeTone {
  if (ms >= RED_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS) return 'red'
  if (ms >= AMBER_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS) return 'amber'
  return 'neutral'
}
