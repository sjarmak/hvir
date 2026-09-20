import { describe, expect, it } from 'vitest'

import {
  TerminalWheelController,
  isTerminalReadBackNavigation,
  isTerminalReadBackNavigationBatch,
  terminalWheelNotch,
  type TerminalWheelEvent,
  type TerminalWheelState,
} from '../src/shared/terminal-wheel'

const baseState: TerminalWheelState = {
  alternateScreen: false,
  mouseTracking: false,
  sgrMouse: false,
  cols: 80,
  rows: 24,
  cellWidth: 10,
  cellHeight: 10,
}

function wheel(
  deltaY: number,
  overrides: Partial<TerminalWheelEvent> = {},
): TerminalWheelEvent {
  return {
    gesture: 'notch',
    deltaY,
    deltaMode: 1,
    offsetX: 0,
    offsetY: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...overrides,
  }
}

function state(overrides: Partial<TerminalWheelState> = {}): TerminalWheelState {
  return { ...baseState, ...overrides }
}

/** One move of a finger, in the surface's own pixels; always continuous distance. */
function drag(
  deltaY: number,
  overrides: Partial<TerminalWheelEvent> = {},
): TerminalWheelEvent {
  return wheel(deltaY, { gesture: 'drag', deltaMode: 0, ...overrides })
}

describe('terminal wheel behavior', () => {
  it('leaves normal-screen scrollback to the terminal engine', () => {
    const controller = new TerminalWheelController()

    expect(controller.handle(wheel(3), state())).toEqual({ handled: false, data: [] })
    expect(controller.handle(wheel(0), state({ alternateScreen: true }))).toEqual({
      handled: false,
      data: [],
    })
  })

  it('accumulates fractional trackpad distance before sending one page key', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })
    const pixels = { deltaMode: 0 }

    expect(controller.handle(wheel(10, pixels), alternate)).toEqual({
      handled: true,
      data: [],
    })
    expect(controller.handle(wheel(10, pixels), alternate)).toEqual({
      handled: true,
      data: [],
    })
    expect(controller.handle(wheel(10, pixels), alternate)).toEqual({
      handled: true,
      data: ['\x1b[6~'],
    })
  })

  it('bounds accelerated alternate-screen events to one page action', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })

    expect(controller.handle(wheel(300, { deltaMode: 0 }), alternate)).toEqual({
      handled: true,
      data: ['\x1b[6~'],
    })
    expect(controller.handle(wheel(-1, { deltaMode: 2 }), alternate)).toEqual({
      handled: true,
      data: ['\x1b[5~'],
    })
  })

  it('builds a notch by reading the fields out, since a browser event holds none of its own', () => {
    // A WheelEvent keeps deltaY and the rest as accessors on its prototype, so
    // a spread of one copies nothing. This is the shape that trap has.
    const browserEvent: Omit<TerminalWheelEvent, 'gesture'> = Object.create({
      deltaY: 42,
      deltaMode: 1,
      offsetX: 7,
      offsetY: 9,
      shiftKey: true,
      altKey: false,
      ctrlKey: true,
    }) as Omit<TerminalWheelEvent, 'gesture'>
    expect(Object.keys(browserEvent)).toEqual([])
    expect(terminalWheelNotch(browserEvent)).toEqual({
      gesture: 'notch',
      deltaY: 42,
      deltaMode: 1,
      offsetX: 7,
      offsetY: 9,
      shiftKey: true,
      altKey: false,
      ctrlKey: true,
    })
  })

  it('charges a drag half the screen for a page and a notch three lines', () => {
    const alternate = state({ alternateScreen: true })
    // 24 rows of 10px: a notch pays 30px for a page, a finger pays 120px, so
    // the same travel that is one page under a finger is four under a wheel.
    const dragging = new TerminalWheelController()
    expect(dragging.handle(drag(119), alternate).data).toEqual([])
    expect(dragging.handle(drag(1), alternate).data).toEqual(['\x1b[6~'])

    const notching = new TerminalWheelController()
    expect(notching.handle(wheel(30, { deltaMode: 0 }), alternate).data).toEqual([
      '\x1b[6~',
    ])
  })

  it('a drag pays a notch for an SGR report, which stands for a notch and not a screen', () => {
    const controller = new TerminalWheelController()
    const mouse = state({ mouseTracking: true, sgrMouse: true })
    // The exempt-from-the-arm page key is the screen-sized step; a report is
    // someone else's notch, so a finger buys one with three lines as ever.
    expect(controller.handle(drag(30), mouse).data).toHaveLength(1)
  })

  it('a taller screen costs a drag more travel per page, and a tiny one never less than a notch', () => {
    const tall = new TerminalWheelController()
    expect(
      tall.handle(drag(120), state({ alternateScreen: true, rows: 48 })).data,
    ).toEqual([])
    expect(
      tall.handle(drag(120), state({ alternateScreen: true, rows: 48 })).data,
    ).toEqual(['\x1b[6~'])

    const tiny = new TerminalWheelController()
    expect(tiny.handle(drag(30), state({ alternateScreen: true, rows: 4 })).data).toEqual(
      ['\x1b[6~'],
    )
  })

  it('banks the steps one event may not carry instead of dropping them', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })
    // Four pages of travel in one event. The route delivers one per event, and
    // the next event finds the rest waiting rather than gone, so how far a
    // gesture travels follows its distance and not the browser's batching.
    expect(controller.handle(drag(480), alternate).data).toEqual(['\x1b[6~'])
    expect(controller.handle(drag(1), alternate).data).toEqual(['\x1b[6~'])
  })

  it('banks one event\u2019s worth and no more, so an absurd delta is rate limited', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })
    expect(controller.handle(drag(120000), alternate).data).toEqual(['\x1b[6~'])
    expect(controller.handle(drag(1), alternate).data).toEqual(['\x1b[6~'])
    expect(controller.handle(drag(1), alternate).data).toEqual([])
  })

  it('the lift of the finger drops the fraction and the bank the drag had, so the next starts at zero', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })
    // Two pages of travel in one move: one goes, one is banked for the next move.
    expect(controller.handle(drag(240), alternate).data).toEqual(['\x1b[6~'])
    controller.endGesture()
    // A fresh touch a hair long finds nothing owed from the last one.
    expect(controller.handle(drag(1), alternate).data).toEqual([])
    // Nine tenths of a page, then the lift, then a tenth: two gestures, no page.
    expect(controller.handle(drag(108), alternate).data).toEqual([])
    controller.endGesture()
    expect(controller.handle(drag(12), alternate).data).toEqual([])
  })

  it('a batch is one or more of the closed set in any order and nothing else', () => {
    const reports = ['\x1b[5~', '\x1b[6~', '\x1b[<64;1;1M', '\x1b[<65;132;43M']
    for (const one of reports) {
      expect(isTerminalReadBackNavigation(one), one).toBe(true)
      expect(isTerminalReadBackNavigationBatch(one), one).toBe(true)
    }
    const batch = reports.join('')
    expect(isTerminalReadBackNavigationBatch(batch)).toBe(true)
    expect(isTerminalReadBackNavigation(batch)).toBe(false)
    expect(isTerminalReadBackNavigationBatch('\x1b[<64;1;1M'.repeat(200))).toBe(true)
    for (const other of [
      '',
      '\r',
      '\x1b[5~\r',
      '\r\x1b[5~',
      '\x1b[<64;1;1M\x1b[<0;1;1M',
      '\x1b[<64;1;1M\x1b[<64;1;1m',
      '\x1b[5~\x1b[',
      '\x1b[5',
    ]) {
      expect(isTerminalReadBackNavigationBatch(other), JSON.stringify(other)).toBe(false)
    }
  })

  it('drops partial momentum when wheel direction reverses', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })

    expect(controller.handle(wheel(2), alternate).data).toEqual([])
    expect(controller.handle(wheel(-1), alternate).data).toEqual([])
    expect(controller.handle(wheel(-2), alternate).data).toEqual(['\x1b[5~'])
  })

  it('resets accumulated distance when local scrollback takes ownership', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })

    expect(controller.handle(wheel(2), alternate).data).toEqual([])
    expect(controller.handle(wheel(3), state()).handled).toBe(false)
    expect(controller.handle(wheel(1), alternate).data).toEqual([])
  })

  it('emits bounded SGR wheel reports with cell coordinates and modifiers', () => {
    const controller = new TerminalWheelController()
    const mouse = state({ mouseTracking: true, sgrMouse: true })

    expect(
      controller.handle(
        wheel(18, {
          offsetX: 24,
          offsetY: 35,
          ctrlKey: true,
        }),
        mouse,
      ),
    ).toEqual({
      handled: true,
      data: Array.from({ length: 5 }, () => '\x1b[<81;3;4M'),
    })

    expect(
      controller.handle(
        wheel(-3, {
          offsetX: 999,
          offsetY: -5,
          shiftKey: true,
          altKey: true,
        }),
        mouse,
      ).data,
    ).toEqual(['\x1b[<76;80;1M'])
  })

  it('consumes unsupported mouse encodings without injecting keyboard input', () => {
    const controller = new TerminalWheelController()
    const legacyMouse = state({
      alternateScreen: true,
      mouseTracking: true,
      sgrMouse: false,
    })

    expect(controller.handle(wheel(3), legacyMouse)).toEqual({ handled: true, data: [] })
  })
})
