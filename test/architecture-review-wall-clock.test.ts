import { expect, it } from 'vitest'
import { translateClock } from '../src/main/architecture-review/wall-clock'

/**
 * A monotonic process clock stops while the machine sleeps, so a long-lived main process
 * falls behind a freshly spawned worker by every suspend it lived through. Both still read
 * the same system wall clock.
 */
it.each([0, 30, 150, -150, 60_000, 3_600_000])(
  'maps a mark from a process whose clock is %i ms off back onto main without drift',
  (sleptMs) => {
    let wall = 1_800_000_000_000
    const workerClock = () => wall - 12_345
    const mainClock = () => wall - 12_345 - sleptMs
    const workerMark = workerClock()
    const mainMark = mainClock()
    wall += 7.5

    const inWall = translateClock(workerClock, () => wall).toWall(workerMark)
    expect(translateClock(mainClock, () => wall).fromWall(inWall)).toBeCloseTo(
      mainMark,
      6,
    )
  },
)

it('samples the offset when the translation is made, not when the process started', () => {
  let wall = 1_000
  let processMs = 1_000
  const translation = () =>
    translateClock(
      () => processMs,
      () => wall,
    )
  expect(translation().toWall(processMs)).toBe(1_000)
  wall += 60_000
  processMs += 5
  expect(translation().toWall(processMs)).toBe(61_000)
})

it('refuses a wall clock or process clock that is not a finite number', () => {
  expect(() =>
    translateClock(
      () => Number.NaN,
      () => 1,
    ),
  ).toThrow(/clock/)
  expect(() =>
    translateClock(
      () => 1,
      () => Number.POSITIVE_INFINITY,
    ),
  ).toThrow(/clock/)
})
