// @vitest-environment happy-dom

/**
 * The read-back gesture's adapter (ADR-053): a finger over the grid becomes
 * the event shape a wheel notch already has, in the emulator's own pixels
 * rather than the on-screen pixels the surface's transform scales them to. No
 * touch over the grid reaches ghostty-web's own canvas `touchend`, which
 * focuses the hidden textarea unconditionally and would raise the phone's soft
 * keyboard and resize the viewport. A lift with speed behind it is a fling that
 * keeps the content moving frame by frame, as a trackpad's momentum does on the
 * desktop, until it rests or a finger lands on it.
 */
import { describe, expect, it } from 'vitest'

import {
  CompanionTouchScroll,
  type CompanionFrameScheduler,
} from '../src/renderer/companion/src/companion-touch-scroll'
import type { TerminalWheelEvent } from '../src/shared'

/** Animation frames the test runs by hand. */
class FramePump implements CompanionFrameScheduler {
  private queued = new Map<number, (now: number) => void>()
  private next = 1

  request(callback: (now: number) => void): number {
    const handle = this.next++
    this.queued.set(handle, callback)
    return handle
  }

  cancel(handle: number): void {
    this.queued.delete(handle)
  }

  get pending(): number {
    return this.queued.size
  }

  /** Runs every frame queued so far at `now`; frames they queue wait for the next pump. */
  pump(now: number): void {
    const due = [...this.queued.values()]
    this.queued.clear()
    for (const callback of due) callback(now)
  }
}

interface FakeTouch {
  readonly identifier: number
  readonly clientX: number
  readonly clientY: number
}

function touch(identifier: number, clientY: number, clientX = 0): FakeTouch {
  return { identifier, clientX, clientY }
}

function dispatch(
  target: EventTarget,
  type: string,
  changedTouches: readonly FakeTouch[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'changedTouches', { value: changedTouches })
  target.dispatchEvent(event)
  return event
}

function scroller(scale = 1): {
  readonly grid: HTMLDivElement
  readonly canvas: HTMLCanvasElement
  readonly gestures: TerminalWheelEvent[]
  readonly reachedCanvas: string[]
  readonly ends: number[]
  readonly touchScroll: CompanionTouchScroll
  /** The document's clock as the adapter reads it; still unless a test moves it. */
  readonly clock: { now: number }
  readonly frames: FramePump
} {
  const clock = { now: 1_000 }
  const frames = new FramePump()
  const grid = document.createElement('div')
  const canvas = document.createElement('canvas')
  grid.append(canvas)
  document.body.append(grid)
  const gestures: TerminalWheelEvent[] = []
  const reachedCanvas: string[] = []
  const ends: number[] = []
  // Stands in for ghostty-web's own canvas touchend, which focuses its textarea.
  canvas.addEventListener('touchend', () => reachedCanvas.push('touchend'))
  const touchScroll = new CompanionTouchScroll({
    element: grid,
    scale: () => scale,
    sink: (event) => gestures.push(event),
    end: () => ends.push(gestures.length),
    now: () => clock.now,
    frames,
  })
  return { grid, canvas, gestures, reachedCanvas, ends, touchScroll, clock, frames }
}

/** A finger crossing 80 px in two moves 16 ms apart and lifting at speed. */
function flick(world: ReturnType<typeof scroller>): void {
  const { canvas, clock } = world
  dispatch(canvas, 'touchstart', [touch(1, 400)])
  clock.now += 16
  dispatch(canvas, 'touchmove', [touch(1, 360)])
  clock.now += 16
  dispatch(canvas, 'touchmove', [touch(1, 320)])
  dispatch(canvas, 'touchend', [touch(1, 320)])
}

/** Runs frames 16 ms apart until the fling rests or the bound is hit. */
function settle(world: ReturnType<typeof scroller>, bound = 1_000): number {
  let frames = 0
  while (world.frames.pending > 0 && frames < bound) {
    world.clock.now += 16
    world.frames.pump(world.clock.now)
    frames += 1
  }
  return frames
}

describe('CompanionTouchScroll', () => {
  it('a drag toward the bottom of the screen reads back and one toward the top reads forward', () => {
    const { canvas, gestures, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 100)])
    dispatch(canvas, 'touchmove', [touch(1, 140)])
    dispatch(canvas, 'touchmove', [touch(1, 110)])
    dispatch(canvas, 'touchend', [touch(1, 110)])
    // A finger toward the bottom carries the content down, the way a wheel
    // notch upward does: the delta a wheel would report is negative.
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([-40, 30])
    expect(gestures[0]?.deltaMode).toBe(0)
    expect(gestures[0]).toMatchObject({ shiftKey: false, altKey: false, ctrlKey: false })
    // Continuous distance, not a notch of intent: the policy reads this to
    // charge a page key half a screen of travel rather than three lines.
    expect(gestures.map((gesture) => gesture.gesture)).toEqual(['drag', 'drag'])
    touchScroll.dispose()
  })

  it('divides on-screen pixels by the surface scale so the content tracks the finger', () => {
    const half = scroller(0.5)
    dispatch(half.canvas, 'touchstart', [touch(1, 200)])
    dispatch(half.canvas, 'touchmove', [touch(1, 180)])
    const full = scroller(1)
    dispatch(full.canvas, 'touchstart', [touch(1, 200)])
    dispatch(full.canvas, 'touchmove', [touch(1, 180)])
    expect(half.gestures[0]?.deltaY).toBe(40)
    expect(full.gestures[0]?.deltaY).toBe(20)
    half.touchScroll.dispose()
    full.touchScroll.dispose()
  })

  it('a flick stops the canvas touchend that would raise the keyboard', () => {
    const { canvas, reachedCanvas, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchmove', [touch(1, 260)])
    dispatch(canvas, 'touchend', [touch(1, 260)])
    expect(reachedCanvas).toEqual([])
    touchScroll.dispose()
  })

  it('a tap sends nothing and still keeps the canvas from taking its touchend', () => {
    const { canvas, gestures, reachedCanvas, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchend', [touch(1, 300)])
    expect(gestures).toEqual([])
    expect(reachedCanvas).toEqual([])
    touchScroll.dispose()
  })

  it('a mostly sideways drag is a gesture the canvas never sees the end of', () => {
    const { canvas, reachedCanvas, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300, 40)])
    dispatch(canvas, 'touchmove', [touch(1, 301, 240)])
    dispatch(canvas, 'touchend', [touch(1, 301, 240)])
    expect(reachedCanvas).toEqual([])
    touchScroll.dispose()
  })

  it('a second finger does not start a second gesture', () => {
    const { canvas, gestures, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 100)])
    dispatch(canvas, 'touchstart', [touch(2, 400)])
    dispatch(canvas, 'touchmove', [touch(2, 300)])
    dispatch(canvas, 'touchmove', [touch(1, 90)])
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([10])
    touchScroll.dispose()
  })

  it('a second finger lifting mid-drag does not let its touchend through', () => {
    const { canvas, gestures, reachedCanvas, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchstart', [touch(2, 500)])
    dispatch(canvas, 'touchmove', [touch(1, 240)])
    dispatch(canvas, 'touchend', [touch(2, 500)])
    expect(reachedCanvas).toEqual([])
    // The primary touch is still the gesture; the drag continues under it.
    dispatch(canvas, 'touchmove', [touch(1, 220)])
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([60, 20])
    touchScroll.dispose()
  })

  it('a cancelled gesture ends, and the next touch starts a fresh one', () => {
    const { canvas, gestures, reachedCanvas, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchmove', [touch(1, 200)])
    dispatch(canvas, 'touchcancel', [touch(1, 200)])
    dispatch(canvas, 'touchmove', [touch(1, 100)])
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([100])

    dispatch(canvas, 'touchstart', [touch(2, 500)])
    dispatch(canvas, 'touchmove', [touch(2, 460)])
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([100, 40])
    expect(reachedCanvas).toEqual([])
    touchScroll.dispose()
  })

  it('the primary finger lifting ends the gesture once, after its last move', () => {
    const { canvas, ends, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchmove', [touch(1, 260)])
    dispatch(canvas, 'touchstart', [touch(2, 500)])
    // A second finger lifting is not the gesture ending.
    dispatch(canvas, 'touchend', [touch(2, 500)])
    expect(ends).toEqual([])
    dispatch(canvas, 'touchmove', [touch(1, 240)])
    dispatch(canvas, 'touchend', [touch(1, 240)])
    expect(ends).toEqual([2])
    // A lift with no gesture under it ends nothing.
    dispatch(canvas, 'touchend', [touch(3, 240)])
    expect(ends).toEqual([2])
    touchScroll.dispose()
  })

  it('a cancelled gesture ends the same way a lift does', () => {
    const { canvas, ends, touchScroll } = scroller()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchmove', [touch(1, 200)])
    dispatch(canvas, 'touchcancel', [touch(1, 200)])
    expect(ends).toEqual([1])
    touchScroll.dispose()
  })

  it('cancels the touch events it owns, so a tap breeds no mouse press for the canvas', () => {
    const { canvas, touchScroll } = scroller()
    // Chrome synthesizes mousedown and click after a touch unless the touch
    // was cancelled, and ghostty-web's canvas mousedown focuses the textarea.
    const start = dispatch(canvas, 'touchstart', [touch(1, 300)])
    const move = dispatch(canvas, 'touchmove', [touch(1, 260)])
    const end = dispatch(canvas, 'touchend', [touch(1, 260)])
    expect([start, move, end].map((event) => event.defaultPrevented)).toEqual([
      true,
      true,
      true,
    ])
    touchScroll.dispose()
  })

  it('a flick keeps the content moving after the lift, slowing until it rests, and ends then', () => {
    const world = scroller()
    const { gestures, ends, frames } = world
    flick(world)
    // The finger covered 80 px at 2.5 px/ms; the lift alone ended nothing.
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([40, 40])
    expect(ends).toEqual([])
    expect(frames.pending).toBe(1)

    const ran = settle(world)
    const coasted = gestures.slice(2).map((gesture) => gesture.deltaY)
    // The first frame moves at the lift's speed, and each frame after moves less.
    expect(coasted[0]).toBeCloseTo(40)
    expect(
      coasted.every((delta, i) => delta > 0 && (i === 0 || delta < coasted[i - 1]!)),
    ).toBe(true)
    // Momentum carries the content many times the finger's own travel.
    const total = coasted.reduce((sum, delta) => sum + delta, 0)
    expect(total).toBeGreaterThan(800)
    expect(total).toBeLessThan(1_600)
    expect(ran).toBeLessThan(1_000)
    expect(frames.pending).toBe(0)
    expect(ends).toEqual([gestures.length])
    expect(gestures.every((gesture) => gesture.gesture === 'drag')).toBe(true)
    world.touchScroll.dispose()
  })

  it('a fling moves the content in the surface\u2019s pixels, divided by the scale like a move', () => {
    const world = scroller(0.5)
    flick(world)
    world.clock.now += 16
    world.frames.pump(world.clock.now)
    expect(world.gestures.map((gesture) => gesture.deltaY)).toEqual([80, 80, 80])
    world.touchScroll.dispose()
  })

  it('a finger that stops before lifting flings nothing and ends at the lift', () => {
    const world = scroller()
    const { canvas, clock, gestures, ends, frames } = world
    dispatch(canvas, 'touchstart', [touch(1, 400)])
    clock.now += 16
    dispatch(canvas, 'touchmove', [touch(1, 300)])
    clock.now += 400
    dispatch(canvas, 'touchend', [touch(1, 300)])
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([100])
    expect(ends).toEqual([1])
    expect(frames.pending).toBe(0)
    world.touchScroll.dispose()
  })

  it('a slow lift is a stop, not a flick', () => {
    const world = scroller()
    const { canvas, clock, ends, frames } = world
    dispatch(canvas, 'touchstart', [touch(1, 400)])
    clock.now += 100
    dispatch(canvas, 'touchmove', [touch(1, 390)])
    dispatch(canvas, 'touchend', [touch(1, 390)])
    expect(ends).toEqual([1])
    expect(frames.pending).toBe(0)
    world.touchScroll.dispose()
  })

  it('a finger landing on a fling catches it, ends that gesture, and starts its own', () => {
    const world = scroller()
    const { canvas, clock, gestures, ends, frames } = world
    flick(world)
    clock.now += 16
    frames.pump(clock.now)
    expect(gestures).toHaveLength(3)
    dispatch(canvas, 'touchstart', [touch(2, 500)])
    expect(ends).toEqual([3])
    expect(frames.pending).toBe(0)
    clock.now += 16
    dispatch(canvas, 'touchmove', [touch(2, 480)])
    expect(gestures.map((gesture) => gesture.deltaY)).toEqual([40, 40, 40, 20])
    world.touchScroll.dispose()
  })

  it('disposing the adapter stops a fling mid-flight', () => {
    const world = scroller()
    flick(world)
    world.touchScroll.dispose()
    expect(world.frames.pending).toBe(0)
    expect(world.ends).toEqual([])
  })

  it('a disposed adapter listens to nothing', () => {
    const { canvas, gestures, reachedCanvas, touchScroll } = scroller()
    touchScroll.dispose()
    dispatch(canvas, 'touchstart', [touch(1, 300)])
    dispatch(canvas, 'touchmove', [touch(1, 200)])
    dispatch(canvas, 'touchend', [touch(1, 200)])
    expect(gestures).toEqual([])
    expect(reachedCanvas).toEqual(['touchend'])
    touchScroll.dispose()
  })
})
