// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MirrorReflow,
  REFLOW_REFRESH_MS,
  reflowText,
} from '../src/renderer/companion/src/companion-mirror-reflow'
import type { CompanionBufferLine } from '../src/renderer/companion/src/companion-terminal-pane'

const line = (text: string, wrapped = false): CompanionBufferLine => ({ text, wrapped })

describe('reflowText', () => {
  it('joins a wrapped row onto the row before it and trims each logical line', () => {
    expect(
      reflowText([
        line('$ echo one  '),
        line('a line the desktop broke at its wid'),
        line('th, continued here   ', true),
        line('done'),
      ]),
    ).toBe('$ echo one\na line the desktop broke at its width, continued here\ndone')
  })

  it('keeps the spaces at a wrap boundary, since only the joined line is trimmed', () => {
    expect(reflowText([line('word '), line('next', true)])).toBe('word next')
  })

  it('drops blank rows at the end and keeps blank rows in between', () => {
    expect(
      reflowText([line('one'), line('   '), line('two'), line(''), line('  ')]),
    ).toBe('one\n\ntwo')
    expect(reflowText([])).toBe('')
    expect(reflowText([line(''), line('')])).toBe('')
  })

  it('a wrapped first row stands alone rather than joining nothing', () => {
    expect(reflowText([line('tail of an earlier line', true), line('next')])).toBe(
      'tail of an earlier line\nnext',
    )
  })
})

describe('MirrorReflow', () => {
  let element: HTMLPreElement
  let lines: CompanionBufferLine[]
  let reflow: MirrorReflow
  let scrollTop: number

  beforeEach(() => {
    vi.useFakeTimers()
    element = document.createElement('pre')
    lines = []
    scrollTop = 0
    // happy-dom lays nothing out: the page is 100px tall and each character 100px of text.
    Object.defineProperty(element, 'clientHeight', { get: () => 100 })
    Object.defineProperty(element, 'scrollHeight', {
      get: () => (element.textContent ?? '').length * 100,
    })
    Object.defineProperty(element, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    reflow = new MirrorReflow(element, () => lines)
  })

  afterEach(() => {
    reflow.dispose()
    vi.useRealTimers()
  })

  it('refresh writes the text now; schedule coalesces requests into one refresh later', () => {
    lines = [line('one')]
    reflow.refresh()
    expect(element.textContent).toBe('one')

    lines = [line('one'), line('two')]
    reflow.schedule()
    reflow.schedule()
    expect(element.textContent).toBe('one')
    vi.advanceTimersByTime(REFLOW_REFRESH_MS - 1)
    expect(element.textContent).toBe('one')
    vi.advanceTimersByTime(1)
    expect(element.textContent).toBe('one\ntwo')

    // The interval is over: the next request is a new refresh.
    lines = [line('three')]
    reflow.schedule()
    vi.advanceTimersByTime(REFLOW_REFRESH_MS)
    expect(element.textContent).toBe('three')
  })

  it('keeps a view at the end at the end, and leaves one scrolled up where it is', () => {
    lines = [line('ab')]
    reflow.refresh()
    expect(scrollTop).toBe(200)

    // At the end (200 + 100 reaches 200): the grown page is followed to its new end.
    lines = [line('abcdef')]
    reflow.refresh()
    expect(scrollTop).toBe(600)

    // Scrolled up to read: the page grows underneath and the view stays put.
    scrollTop = 100
    lines = [line('abcdefghij')]
    reflow.refresh()
    expect(scrollTop).toBe(100)
  })

  it('does nothing after dispose, and a scheduled refresh never fires', () => {
    lines = [line('late')]
    reflow.schedule()
    reflow.dispose()
    vi.advanceTimersByTime(REFLOW_REFRESH_MS)
    reflow.refresh()
    expect(element.textContent).toBe('')
  })
})
