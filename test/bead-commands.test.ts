import { describe, expect, it } from 'vitest'

import {
  BEAD_ACTIONS,
  BEAD_ACTION_HINTS,
  BEAD_ACTION_LABELS,
  availableBeadActions,
  beadCommand,
  normalizeBeadTitle,
} from '../src/renderer/src/beads/bead-commands'

describe('beadCommand', () => {
  it('builds claim as bd update --claim with no reuse key', () => {
    expect(beadCommand({ action: 'claim', id: 'hv-12' })).toEqual({
      command: "bd update 'hv-12' --claim",
    })
  })

  it('builds close as bd close with no reuse key', () => {
    expect(beadCommand({ action: 'close', id: 'hv-12' })).toEqual({
      command: "bd close 'hv-12'",
    })
  })

  it('builds create with the title passed by --title', () => {
    expect(beadCommand({ action: 'create', title: 'Fix the thing' })).toEqual({
      command: "bd create --title 'Fix the thing'",
    })
  })

  it('keeps a leading-dash title a title rather than a bd flag', () => {
    expect(beadCommand({ action: 'create', title: '-v flag is ignored' })?.command).toBe(
      "bd create --title '-v flag is ignored'",
    )
  })

  it('single-quotes titles so shell metacharacters stay literal', () => {
    expect(beadCommand({ action: 'create', title: "don't break" })?.command).toBe(
      "bd create --title 'don'\\''t break'",
    )
  })

  it('accepts every id shape bd issues today', () => {
    for (const id of [
      'projects-5c6',
      'projects-sl7.4',
      'hv-12',
      'gc-mol-a1',
      'd905c314-d3cd-5d4e-8bb9-ff2a644aebe0',
    ]) {
      expect(beadCommand({ action: 'claim', id })?.command).toBe(
        `bd update '${id}' --claim`,
      )
    }
  })

  it('refuses an id carrying terminal control bytes rather than quoting it', () => {
    // Quoting cannot help: the command is delivered as keystrokes, so Ctrl-C
    // interrupts the line editor and the newline submits whatever follows.
    expect(beadCommand({ action: 'claim', id: "hv-1'\u0003rm -rf /\n" })).toBeUndefined()
    expect(beadCommand({ action: 'close', id: 'hv-1\u001b[A' })).toBeUndefined()
    expect(beadCommand({ action: 'close', id: 'hv-1\u0085' })).toBeUndefined()
  })

  it('refuses an id outside the bd identifier grammar without rewriting it', () => {
    expect(beadCommand({ action: 'close', id: "a'; rm -rf /" })).toBeUndefined()
    expect(beadCommand({ action: 'close', id: 'hv 1' })).toBeUndefined()
    expect(beadCommand({ action: 'close', id: '' })).toBeUndefined()
    expect(beadCommand({ action: 'close', id: 'hv-1\u2028' })).toBeUndefined()
  })

  it('refuses a title that still carries a line or paragraph separator', () => {
    expect(beadCommand({ action: 'create', title: 'one\u2028two' })).toBeUndefined()
    expect(beadCommand({ action: 'create', title: 'one\u0003two' })).toBeUndefined()
  })
})

describe('normalizeBeadTitle', () => {
  it('collapses whitespace runs, including newlines, to one space and trims', () => {
    // A newline typed into the terminal would submit the command early.
    expect(normalizeBeadTitle('  Fix\nthe\t thing  ')).toBe('Fix the thing')
  })

  it('collapses Unicode line and paragraph separators like any other whitespace', () => {
    expect(normalizeBeadTitle('one\u2028two\u2029three')).toBe('one two three')
  })

  it('removes control characters the line editor would read as keys', () => {
    // ESC [ A is an up-arrow to readline; \u0003 is Ctrl-C. Neither may reach the PTY.
    expect(normalizeBeadTitle('x\u001b[Ay')).toBe('x [Ay')
    expect(normalizeBeadTitle('stop\u0003now')).toBe('stop now')
    expect(normalizeBeadTitle('\u0003\u001b')).toBe('')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeBeadTitle(' \n\t ')).toBe('')
  })
})

describe('availableBeadActions', () => {
  it('offers nothing on a closed bead', () => {
    expect(availableBeadActions('closed')).toEqual([])
  })

  it('offers only close on an in-progress bead', () => {
    expect(availableBeadActions('in_progress')).toEqual(['close'])
  })

  it('offers claim and close on an open bead', () => {
    expect(availableBeadActions('open')).toEqual(['claim', 'close'])
  })

  it('degrades to claim and close for a status it does not know', () => {
    // A future bd status other than `closed` still shows both; bd itself
    // refuses in the terminal if the transition is invalid.
    expect(availableBeadActions('weird')).toEqual(['claim', 'close'])
  })
})

describe('bead action vocabulary', () => {
  it('has a label and hint for every action', () => {
    expect(Object.keys(BEAD_ACTION_LABELS).sort()).toEqual([...BEAD_ACTIONS].sort())
    expect(Object.keys(BEAD_ACTION_HINTS).sort()).toEqual([...BEAD_ACTIONS].sort())
  })
})
