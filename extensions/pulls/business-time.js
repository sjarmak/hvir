/* global window, module */
/**
 * Business time (ADR-976): elapsed milliseconds that skip Saturdays and Sundays in local time.
 * Days are walked between local midnights, so a DST day counts its real 23 or 25 hours.
 * Holidays are not skipped. Loaded by the views and by node --test.
 */
;(() => {
  const BUSINESS_DAY_MS = 86_400_000
  const AMBER_AFTER_BUSINESS_DAYS = 1
  const RED_AFTER_BUSINESS_DAYS = 3
  const HOUR_MS = 3_600_000
  const MINUTE_MS = 60_000

  const isWeekend = (ms) => [0, 6].includes(new Date(ms).getDay())

  function nextLocalMidnight(ms) {
    const date = new Date(ms)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  }

  /** Business milliseconds from `from` to `to` (epoch ms); 0 when `to` is not later. */
  function businessMsBetween(from, to) {
    let total = 0
    for (let cursor = from; cursor < to; ) {
      const dayEnd = Math.min(nextLocalMidnight(cursor), to)
      if (!isWeekend(cursor)) total += dayEnd - cursor
      cursor = dayEnd
    }
    return total
  }

  /** Minutes under an hour, hours under a business day, otherwise whole business days. */
  function formatBusinessAge(ms) {
    if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`
    if (ms < BUSINESS_DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`
    return `${Math.floor(ms / BUSINESS_DAY_MS)}d`
  }

  function businessAgeTone(ms) {
    if (ms >= RED_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS) return 'red'
    if (ms >= AMBER_AFTER_BUSINESS_DAYS * BUSINESS_DAY_MS) return 'amber'
    return 'neutral'
  }

  const api = Object.freeze({ BUSINESS_DAY_MS, businessMsBetween, formatBusinessAge, businessAgeTone })
  if (typeof module === 'object') module.exports = api
  else window.businessTime = api
})()
