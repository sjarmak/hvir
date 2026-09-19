// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HISTORY_REFRESH_MS,
  MirrorHistory,
  historyText,
} from '../src/renderer/companion/src/companion-mirror-history'
import type { CompanionBufferLine } from '../src/renderer/companion/src/companion-terminal-pane'

const line = (text: string, wrapped = false): CompanionBufferLine => ({ text, wrapped })

describe('historyText', () => {
  it('keeps every row as the grid holds it, wrapped rows and blanks included', () => {
    expect(
      historyText([line('one  '), line('two', true), line(''), line('  four')]),
    ).toBe('one  \ntwo\n\n  four')
    expect(historyText([])).toBe('')
  })
})

describe('MirrorHistory', () => {
  let scroller: HTMLDivElement
  let text: HTMLElement
  let lines: CompanionBufferLine[]
  let history: MirrorHistory
  let scrollTop: number
  let after: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    scroller = document.createElement('div')
    text = document.createElement('pre')
    scroller.append(text)
    lines = []
    scrollTop = 0
    after = []
    // happy-dom lays nothing out: the host is 100px tall and each character 100px of text.
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
    history = new MirrorHistory({
      scroller,
      text,
      source: () => lines,
      afterRefresh: () => after.push(text.textContent ?? ''),
    })
  })

  afterEach(() => {
    history.dispose()
    vi.useRealTimers()
  })

  it('refresh writes the rows now; schedule coalesces requests into one refresh later', () => {
    lines = [line('one')]
    history.refresh()
    expect(text.textContent).toBe('one')
    expect(after).toEqual(['one'])

    lines = [line('one'), line('two')]
    history.schedule()
    history.schedule()
    expect(text.textContent).toBe('one')
    vi.advanceTimersByTime(HISTORY_REFRESH_MS - 1)
    expect(text.textContent).toBe('one')
    vi.advanceTimersByTime(1)
    expect(text.textContent).toBe('one\ntwo')

    // The interval is over: the next request is a new refresh.
    lines = [line('three')]
    history.schedule()
    vi.advanceTimersByTime(HISTORY_REFRESH_MS)
    expect(text.textContent).toBe('three')
    expect(after).toEqual(['one', 'one\ntwo', 'three'])
  })

  it('keeps a view at the end at the end, after the column had its say, and leaves one scrolled up', () => {
    lines = [line('ab')]
    history.refresh()
    expect(scrollTop).toBe(200)

    // At the end (200 + 100 reaches 200): the grown column is followed to its new end.
    lines = [line('abcdef')]
    history.refresh()
    expect(scrollTop).toBe(600)

    // Scrolled up to read: the column grows underneath and the view stays put.
    scrollTop = 100
    lines = [line('abcdefghij')]
    history.refresh()
    expect(scrollTop).toBe(100)
  })

  it('does nothing after dispose, and a scheduled refresh never fires', () => {
    lines = [line('late')]
    history.schedule()
    history.dispose()
    vi.advanceTimersByTime(HISTORY_REFRESH_MS)
    history.refresh()
    expect(text.textContent).toBe('')
    expect(after).toEqual([])
  })
})
