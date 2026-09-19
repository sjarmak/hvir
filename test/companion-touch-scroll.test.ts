// @vitest-environment happy-dom

/**
 * The read-back gesture's adapter (ADR-053): a finger over the grid becomes
 * the event shape a wheel notch already has, in the emulator's own pixels
 * rather than the on-screen pixels the surface's transform scales them to. No
 * touch over the grid reaches ghostty-web's own canvas `touchend`, which
 * focuses the hidden textarea unconditionally and would raise the phone's soft
 * keyboard, resize the viewport, and ask the desktop for a new grid while Away.
 */
import { describe, expect, it } from 'vitest'

import { CompanionTouchScroll } from '../src/renderer/companion/src/companion-touch-scroll'
import type { TerminalWheelEvent } from '../src/shared'

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
  readonly touchScroll: CompanionTouchScroll
} {
  const grid = document.createElement('div')
  const canvas = document.createElement('canvas')
  grid.append(canvas)
  document.body.append(grid)
  const gestures: TerminalWheelEvent[] = []
  const reachedCanvas: string[] = []
  // Stands in for ghostty-web's own canvas touchend, which focuses its textarea.
  canvas.addEventListener('touchend', () => reachedCanvas.push('touchend'))
  const touchScroll = new CompanionTouchScroll({
    element: grid,
    scale: () => scale,
    sink: (event) => gestures.push(event),
  })
  return { grid, canvas, gestures, reachedCanvas, touchScroll }
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
