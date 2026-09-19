// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MirrorText,
  REFLOW_REFRESH_MS,
  historyText,
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

describe('historyText', () => {
  it('keeps every row as the grid holds it, wrapped rows and blanks included', () => {
    expect(
      historyText([line('one  '), line('two', true), line(''), line('  four')]),
    ).toBe('one  \ntwo\n\n  four')
    expect(historyText([])).toBe('')
  })
})

describe('MirrorText', () => {
  let scroller: HTMLPreElement
  let text: HTMLElement
  let lines: CompanionBufferLine[]
  let mirror: MirrorText
  let scrollTop: number
  let after: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    scroller = document.createElement('pre')
    text = document.createElement('span')
    scroller.append(text)
    lines = []
    scrollTop = 0
    after = []
    // happy-dom lays nothing out: the page is 100px tall and each character 100px of text.
    Object.defineProperty(scroller, 'clientHeight', { get: () => 100 })
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => (scroller.textContent ?? '').length * 100,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    mirror = new MirrorText({
      scroller,
      text,
      source: () => lines,
      format: reflowText,
      afterRefresh: () => after.push(text.textContent ?? ''),
    })
  })

  afterEach(() => {
    mirror.dispose()
    vi.useRealTimers()
  })

  it('refresh writes the text now; schedule coalesces requests into one refresh later', () => {
    lines = [line('one')]
    mirror.refresh()
    expect(text.textContent).toBe('one')
    expect(after).toEqual(['one'])

    lines = [line('one'), line('two')]
    mirror.schedule()
    mirror.schedule()
    expect(text.textContent).toBe('one')
    vi.advanceTimersByTime(REFLOW_REFRESH_MS - 1)
    expect(text.textContent).toBe('one')
    vi.advanceTimersByTime(1)
    expect(text.textContent).toBe('one\ntwo')

    // The interval is over: the next request is a new refresh.
    lines = [line('three')]
    mirror.schedule()
    vi.advanceTimersByTime(REFLOW_REFRESH_MS)
    expect(text.textContent).toBe('three')
    expect(after).toEqual(['one', 'one\ntwo', 'three'])
  })

  it('keeps a view at the end at the end, after the extent had its say, and leaves one scrolled up', () => {
    lines = [line('ab')]
    mirror.refresh()
    expect(scrollTop).toBe(200)

    // At the end (200 + 100 reaches 200): the grown page is followed to its new end.
    lines = [line('abcdef')]
    mirror.refresh()
    expect(scrollTop).toBe(600)

    // Scrolled up to read: the page grows underneath and the view stays put.
    scrollTop = 100
    lines = [line('abcdefghij')]
    mirror.refresh()
    expect(scrollTop).toBe(100)
  })

  it('does nothing after dispose, and a scheduled refresh never fires', () => {
    lines = [line('late')]
    mirror.schedule()
    mirror.dispose()
    vi.advanceTimersByTime(REFLOW_REFRESH_MS)
    mirror.refresh()
    expect(text.textContent).toBe('')
    expect(after).toEqual([])
  })
})
