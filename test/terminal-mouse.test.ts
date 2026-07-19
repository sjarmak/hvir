import { describe, expect, it } from 'vitest'

import {
  terminalMouseButton,
  type TerminalMouseButtonEvent,
  type TerminalMouseState,
} from '../src/renderer/src/terminal/terminal-mouse'

const baseEvent: TerminalMouseButtonEvent = {
  button: 0,
  offsetX: 24,
  offsetY: 35,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
}

const baseState: TerminalMouseState = {
  mouseTracking: true,
  sgrMouse: true,
  cols: 80,
  rows: 24,
  cellWidth: 10,
  cellHeight: 10,
}

describe('terminal mouse-button behavior', () => {
  it('emits SGR press and release reports at terminal cell coordinates', () => {
    expect(terminalMouseButton('press', baseEvent, baseState)).toEqual({
      handled: true,
      data: '\x1b[<0;3;4M',
    })
    expect(terminalMouseButton('release', baseEvent, baseState)).toEqual({
      handled: true,
      data: '\x1b[<0;3;4m',
    })
  })

  it('maps middle and right buttons and preserves modifiers', () => {
    expect(
      terminalMouseButton(
        'press',
        { ...baseEvent, button: 1, shiftKey: true, altKey: true, ctrlKey: true },
        baseState,
      ).data,
    ).toBe('\x1b[<29;3;4M')
    expect(
      terminalMouseButton('press', { ...baseEvent, button: 2 }, baseState).data,
    ).toBe('\x1b[<2;3;4M')
  })

  it('clamps coordinates to the terminal grid', () => {
    expect(
      terminalMouseButton('press', { ...baseEvent, offsetX: 999, offsetY: -5 }, baseState)
        .data,
    ).toBe('\x1b[<0;80;1M')
  })

  it('leaves mouse events alone when tracking is disabled', () => {
    expect(
      terminalMouseButton('press', baseEvent, { ...baseState, mouseTracking: false }),
    ).toEqual({ handled: false })
  })

  it('consumes unsupported legacy mouse encoding without emitting data', () => {
    expect(
      terminalMouseButton('press', baseEvent, { ...baseState, sgrMouse: false }),
    ).toEqual({ handled: true })
  })

  it('ignores browser navigation buttons', () => {
    expect(terminalMouseButton('press', { ...baseEvent, button: 3 }, baseState)).toEqual({
      handled: false,
    })
  })
})
