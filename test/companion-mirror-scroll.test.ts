// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MirrorScrollGestures,
  consumeScrollDistance,
} from '../src/renderer/companion/src/companion-mirror-scroll'

describe('consumeScrollDistance', () => {
  it('turns pixels into whole lines and carries the fraction to the next event', () => {
    const first = consumeScrollDistance(0, 40, 16)
    expect(first).toEqual({ lines: 2, remainder: 0.5 })
    const second = consumeScrollDistance(first.remainder, 8, 16)
    expect(second).toEqual({ lines: 1, remainder: 0 })
  })

  it('scrolls up on a negative distance and drops the fraction on a direction change', () => {
    const down = consumeScrollDistance(0, 24, 16)
    expect(down).toEqual({ lines: 1, remainder: 0.5 })
    const up = consumeScrollDistance(down.remainder, -16, 16)
    expect(up).toEqual({ lines: -1, remainder: 0 })
  })

  it('moves nothing while the grid has no row height', () => {
    expect(consumeScrollDistance(0.25, 100, 0)).toEqual({ lines: 0, remainder: 0.25 })
    expect(consumeScrollDistance(0.25, Number.NaN, 16)).toEqual({ lines: 0, remainder: 0.25 })
  })
})

describe('MirrorScrollGestures', () => {
  let gestures: MirrorScrollGestures | undefined

  afterEach(() => {
    gestures?.dispose()
    gestures = undefined
    document.body.replaceChildren()
  })

  function attach(rowHeight = 16): {
    readonly host: HTMLDivElement
    readonly canvas: HTMLDivElement
    readonly scrolls: number[]
    readonly captured: number[]
    readonly released: number[]
  } {
    const host = document.createElement('div')
    const canvas = document.createElement('div')
    host.append(canvas)
    document.body.append(host)
    const captured: number[] = []
    const released: number[] = []
    const set = host.setPointerCapture.bind(host)
    const release = host.releasePointerCapture.bind(host)
    host.setPointerCapture = vi.fn((id: number) => {
      captured.push(id)
      set(id)
    })
    host.releasePointerCapture = vi.fn((id: number) => {
      released.push(id)
      release(id)
    })
    const scrolls: number[] = []
    gestures = new MirrorScrollGestures(host, {
      rowHeight: () => rowHeight,
      scrollLines: (lines) => scrolls.push(lines),
    })
    return { host, canvas, scrolls, captured, released }
  }

  function pointer(
    target: HTMLElement,
    type: string,
    position: { readonly x?: number; readonly y: number },
    pointerType = 'touch',
  ): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType,
        clientX: position.x ?? 0,
        clientY: position.y,
        bubbles: true,
      }),
    )
  }

  /** The touchend the browser fires after the pointer sequence, on the touched element. */
  function touchEnd(
    canvas: HTMLElement,
    cancelable: boolean,
  ): { readonly reachedCanvas: boolean; readonly prevented: boolean } {
    let reachedCanvas = false
    const listener = (): void => {
      reachedCanvas = true
    }
    canvas.addEventListener('touchend', listener)
    const event = new TouchEvent('touchend', { bubbles: true, cancelable })
    canvas.dispatchEvent(event)
    canvas.removeEventListener('touchend', listener)
    return { reachedCanvas, prevented: event.defaultPrevented }
  }

  it('a touch drag scrolls by whole rows in the direction of the finger', () => {
    const { host, canvas, scrolls } = attach()
    pointer(canvas, 'pointerdown', { y: 200 })
    pointer(canvas, 'pointermove', { y: 160 })
    expect(scrolls).toEqual([2])
    pointer(canvas, 'pointermove', { y: 152 })
    expect(scrolls).toEqual([2, 1])
    pointer(canvas, 'pointermove', { y: 200 })
    expect(scrolls).toEqual([2, 1, -3])
    pointer(canvas, 'pointerup', { y: 200 })
    touchEnd(canvas, true)
    pointer(host, 'pointermove', { y: 100 })
    expect(scrolls).toEqual([2, 1, -3])
  })

  it('captures the pointer so a drag keeps scrolling past the host box, and releases it after', () => {
    const { host, canvas, scrolls, captured, released } = attach()
    host.getBoundingClientRect = () =>
      ({ top: 100, bottom: 300, left: 0, right: 300, width: 300, height: 200 }) as DOMRect
    pointer(canvas, 'pointerdown', { y: 200 })
    expect(captured).toEqual([1])
    expect(host.hasPointerCapture(1)).toBe(true)
    pointer(host, 'pointermove', { y: 20 })
    expect(scrolls).toEqual([11])
    pointer(host, 'pointermove', { y: -60 })
    expect(scrolls).toEqual([11, 5])
    pointer(host, 'pointerup', { y: -60 })
    expect(released).toEqual([1])
    expect(host.hasPointerCapture(1)).toBe(false)
  })

  it('a cancelled pointer is released and its touchend is consumed', () => {
    const { canvas, captured, released } = attach()
    pointer(canvas, 'pointerdown', { y: 200 })
    pointer(canvas, 'pointermove', { y: 197 })
    pointer(canvas, 'pointercancel', { y: 197 })
    expect(captured).toEqual([1])
    expect(released).toEqual([1])
    expect(touchEnd(canvas, false).reachedCanvas).toBe(false)
  })

  it('a mouse drag is left to the emulator', () => {
    const { canvas, scrolls, captured } = attach()
    pointer(canvas, 'pointerdown', { y: 200 }, 'mouse')
    pointer(canvas, 'pointermove', { y: 100 }, 'mouse')
    expect(scrolls).toEqual([])
    expect(captured).toEqual([])
  })

  it('the touchend after a vertical drag or a sideways pan is consumed; a tap passes through', () => {
    const { canvas } = attach()
    pointer(canvas, 'pointerdown', { y: 200 })
    pointer(canvas, 'pointermove', { y: 100 })
    pointer(canvas, 'pointerup', { y: 100 })
    expect(touchEnd(canvas, true)).toEqual({ reachedCanvas: false, prevented: true })

    pointer(canvas, 'pointerdown', { x: 10, y: 200 })
    pointer(canvas, 'pointermove', { x: 50, y: 203 })
    pointer(canvas, 'pointerup', { x: 50, y: 203 })
    expect(touchEnd(canvas, false)).toEqual({ reachedCanvas: false, prevented: false })

    pointer(canvas, 'pointerdown', { x: 10, y: 200 })
    pointer(canvas, 'pointermove', { x: 14, y: 195 })
    pointer(canvas, 'pointerup', { x: 14, y: 195 })
    expect(touchEnd(canvas, true)).toEqual({ reachedCanvas: true, prevented: false })
  })

  it('does nothing after dispose', () => {
    const { canvas, scrolls, captured } = attach()
    gestures?.dispose()
    gestures = undefined
    pointer(canvas, 'pointerdown', { y: 200 })
    pointer(canvas, 'pointermove', { y: 100 })
    expect(scrolls).toEqual([])
    expect(captured).toEqual([])
  })
})
