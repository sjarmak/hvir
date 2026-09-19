import { describe, expect, it } from 'vitest'

import { terminalDimension } from '../src/main/pty/terminal-dimension'

describe('terminalDimension', () => {
  it.each<{ readonly name: string; readonly value: number; readonly expected: number }>([
    { name: 'keeps an in-range integer', value: 132, expected: 132 },
    { name: 'floors a fractional measurement', value: 43.9, expected: 43 },
    { name: 'raises anything below two to two', value: 1, expected: 2 },
    { name: 'raises zero to two', value: 0, expected: 2 },
    { name: 'raises a negative value to two', value: -7, expected: 2 },
    { name: 'caps at one thousand', value: 4096, expected: 1000 },
    { name: 'keeps the cap itself', value: 1000, expected: 1000 },
    { name: 'falls back to 80 for NaN', value: Number.NaN, expected: 80 },
    {
      name: 'falls back to 80 for infinity',
      value: Number.POSITIVE_INFINITY,
      expected: 80,
    },
    {
      name: 'falls back to 80 for negative infinity',
      value: Number.NEGATIVE_INFINITY,
      expected: 80,
    },
  ])('$name', ({ value, expected }) => {
    expect(terminalDimension(value)).toBe(expected)
  })
})
