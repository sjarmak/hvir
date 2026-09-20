import { describe, expect, it } from 'vitest'

import { PTY_OUTPUT_TAIL_CHARS } from '../src/main/pty/pty-output-tail'
import {
  STICKY_MODE_PREAMBLE_MAX_CHARS,
  TerminalStickyModes,
} from '../src/shared/terminal-sticky-modes'

const ENTER = '\u001b[?1049h'

describe('TerminalStickyModes', () => {
  it('holds an alternate-screen enter the window has already dropped', () => {
    const modes = new TerminalStickyModes()
    modes.retain(ENTER)
    const later = PTY_OUTPUT_TAIL_CHARS + 50_000
    modes.retain('x'.repeat(later))
    expect(modes.preamble(later)).toBe(ENTER)
  })

  it('names only the modes the window it is given can no longer prove', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}one`)
    modes.retain('two')
    expect(modes.preamble(6)).toBe(ENTER)
    expect(modes.preamble(13)).toBe(ENTER)
    expect(modes.preamble(14)).toBe('')
    expect(modes.preamble(500)).toBe('')
  })

  it('emits nothing once a carried mode is reset', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}painting the alternate screen`)
    modes.retain('leaving now\u001b[?1049l$ ')
    modes.retain('y'.repeat(100))
    expect(modes.preamble(100)).toBe('')
  })

  it('emits one sequence for a mode set twice', () => {
    const modes = new TerminalStickyModes()
    modes.retain(ENTER)
    modes.retain(ENTER)
    modes.retain('z'.repeat(20))
    expect(modes.preamble(20)).toBe(ENTER)
  })

  it('reads a combined set however the stream splits it', () => {
    const combined = '\u001b[?1049;1002;1006h'
    // tmux asks for the alternate screen and its mouse modes in one sequence,
    // and every carried parameter in it is kept whatever the read boundary.
    const expected = `${ENTER}\u001b[?1002h\u001b[?1006h`
    for (let cut = 0; cut <= combined.length; cut += 1) {
      const modes = new TerminalStickyModes()
      modes.retain(combined.slice(0, cut))
      modes.retain(combined.slice(cut))
      modes.retain('x'.repeat(100))
      expect(modes.preamble(100), `set cut at ${cut}`).toBe(expected)
    }
  })

  it('reads a combined reset however the stream splits it', () => {
    const reset = '\u001b[?1049;1002;1003;1006;1015;2004;1l'
    for (let cut = 0; cut <= reset.length; cut += 1) {
      const modes = new TerminalStickyModes()
      modes.retain(ENTER)
      modes.retain(reset.slice(0, cut))
      modes.retain(reset.slice(cut))
      modes.retain('x'.repeat(100))
      expect(modes.preamble(100), `reset cut at ${cut}`).toBe('')
    }
  })

  it('recognises a sequence delivered one character at a time', () => {
    const perCharacter = new TerminalStickyModes()
    for (const character of `${ENTER}more output`) perCharacter.retain(character)
    expect(perCharacter.preamble(11)).toBe(ENTER)

    const loneEscape = new TerminalStickyModes()
    loneEscape.retain('output\u001b')
    loneEscape.retain(`${ENTER}more output`)
    expect(loneEscape.preamble(11)).toBe(ENTER)
  })

  it('carries the legacy alternate screen and its xterm spelling as one mode', () => {
    for (const enter of ['\u001b[?47h', '\u001b[?1047h']) {
      const modes = new TerminalStickyModes()
      modes.retain(enter)
      modes.retain('x'.repeat(40))
      expect(modes.preamble(40), enter).toBe('\u001b[?47h')
      modes.retain('\u001b[?1047l')
      modes.retain('y'.repeat(40))
      expect(modes.preamble(40), enter).toBe('')
    }
  })

  it('never emits a dangling synchronized-output set', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?2026hhalf a frame`)
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('never emits a cursor save, which has no steady state', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?1048h`)
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('carries the mouse tracking family whole, in emission order (ADR-056)', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?1h\u001b[?1000h\u001b[?1002h\u001b[?1003h`)
    modes.retain('\u001b[?1006h\u001b[?1015h\u001b[?2004h')
    modes.retain('x'.repeat(100))
    // The screens first, since the reports are read against a screen, and the
    // encoding with the trackers: a reader told the program tracks the mouse
    // but not how to encode for it consumes every gesture and sends nothing.
    expect(modes.preamble(100)).toBe(
      `${ENTER}\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?1015h`,
    )
  })

  it('leaves out the keystroke modes, which change what a key means', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?1h\u001b[?2004h`)
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('emits no mouse mode for a program that turned tracking off again', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?1000h\u001b[?1006h`)
    modes.retain('\u001b[?1000l\u001b[?1006l')
    modes.retain('x'.repeat(100))
    // A fresh emulator starts with tracking off, so the reset needs no sequence.
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('leaves out the cosmetic modes, which the program restores or costs one cell', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?25l\u001b[?7l`)
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('bounds the preamble at STICKY_MODE_PREAMBLE_MAX_CHARS with every mode set', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`${ENTER}\u001b[?47h\u001b[?1000h\u001b[?1002h`)
    modes.retain('\u001b[?1003h\u001b[?1006h\u001b[?1015h')
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100).length).toBe(STICKY_MODE_PREAMBLE_MAX_CHARS)
  })

  it('reads a parameter longer than any carried mode without holding it', () => {
    const modes = new TerminalStickyModes()
    modes.retain('\u001b[?123456789012345678901234567890;1049h')
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('ignores an escape that never becomes a private mode sequence', () => {
    const modes = new TerminalStickyModes()
    modes.retain(`\u001b[?J\u001b[2J\u001b[?1049\u001b[H${ENTER}`)
    modes.retain('x'.repeat(100))
    expect(modes.preamble(100)).toBe(ENTER)
  })

  it('clear forgets every mode and the position they were seen at', () => {
    const modes = new TerminalStickyModes()
    modes.retain(ENTER)
    modes.retain('x'.repeat(100))
    modes.clear()
    modes.retain('y'.repeat(100))
    expect(modes.preamble(100)).toBe('')
  })

  it('retains a long run of one-character chunks without slowing down', () => {
    const modes = new TerminalStickyModes()
    const count = PTY_OUTPUT_TAIL_CHARS + 50_000
    const started = performance.now()
    for (let index = 0; index < count; index += 1) {
      modes.retain(String.fromCharCode(97 + (index % 26)))
    }
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(modes.preamble(count)).toBe('')
  })
})
