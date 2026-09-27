import { expect, it } from 'vitest'
import { commitDate } from '../src/renderer/src/git/commit-date'

it('keeps the calendar date the author recorded, whatever the offset', () => {
  expect(commitDate('2026-09-26T23:30:00-05:00')).toBe('2026-09-26')
  expect(commitDate('2026-09-27T00:30:00+09:00')).toBe('2026-09-27')
  expect(commitDate('2026-09-26T10:00:00+00:00')).toBe('2026-09-26')
})

it('falls back to the local calendar date for other parsable forms', () => {
  const local = new Date(2026, 8, 26, 23, 30)
  expect(commitDate(local.toString())).toBe('2026-09-26')
})

it('shows an unparsable value as it came', () => {
  expect(commitDate('yesterday')).toBe('yesterday')
})
