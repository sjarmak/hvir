// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HISTORY_LINE_LIMIT,
  HISTORY_REFRESH_MS,
} from '../src/renderer/companion/src/companion-mirror-history'
import {
  FIT_SETTLE_MS,
  type CompanionResizeAnswer,
} from '../src/renderer/companion/src/companion-terminal-fit'
import {
  CompanionTerminalMount,
  fitWidthScale,
} from '../src/renderer/companion/src/companion-terminal-mount'
import type { CompanionTerminalPane } from '../src/renderer/companion/src/companion-terminal-pane'
import { asSessionsTerminalHandle } from '../src/shared'
import { FakeCompanionPane } from './companion-page-fixture'

const ROW = asSessionsTerminalHandle('row-1')

async function microtasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountWith(
  create: (cols: number, rows: number) => Promise<CompanionTerminalPane>,
  answer: CompanionResizeAnswer = { outcome: 'accepted' },
): {
  readonly mount: CompanionTerminalMount
  readonly host: HTMLDivElement
  readonly failures: unknown[]
  readonly inputs: string[]
  readonly resizes: { readonly cols: number; readonly rows: number }[]
  readonly answers: CompanionResizeAnswer[]
} {
  const host = document.createElement('div')
  document.body.append(host)
  const failures: unknown[] = []
  const inputs: string[] = []
  const resizes: { readonly cols: number; readonly rows: number }[] = []
  const answers: CompanionResizeAnswer[] = []
  const mount = new CompanionTerminalMount({
    host,
    createPane: create,
    onInput: (data) => inputs.push(data),
    onResize: (cols, rows) => {
      resizes.push({ cols, rows })
      return Promise.resolve(answer)
    },
    onResizeAnswered: (answered) => answers.push(answered),
    onFailure: (error) => failures.push(error),
  })
  return { mount, host, failures, inputs, resizes, answers }
}

/** happy-dom lays nothing out: the host's size is stated for the fit. */
function layout(host: HTMLElement, width: number, height: number): void {
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => height })
}

/** happy-dom's ResizeObserver never fires: this one is fired by the test. */
function observedResizes(): { readonly fire: () => void } {
  const callbacks: (() => void)[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe(): void {}
      disconnect(): void {}
    },
  )
  return { fire: () => callbacks.forEach((callback) => callback()) }
}

function fakePanes(): {
  readonly panes: FakeCompanionPane[]
  readonly create: (cols: number, rows: number) => Promise<CompanionTerminalPane>
} {
  const panes: FakeCompanionPane[] = []
  return {
    panes,
    create: (cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    },
  }
}

describe('fitWidthScale', () => {
  it('scales the grid down to the host width, never up', () => {
    expect(fitWidthScale(400, 1000)).toBe(0.4)
    expect(fitWidthScale(2000, 1000)).toBe(1)
  })

  it('has no scale while the host or the grid has no layout', () => {
    expect(fitWidthScale(0, 1000)).toBeUndefined()
    expect(fitWidthScale(400, 0)).toBeUndefined()
  })
})

describe('CompanionTerminalMount', () => {
  it('writes the sticky-mode preamble before the tail it precedes', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({
      type: 'opened',
      handle: ROW,
      cols: 100,
      rows: 30,
      preamble: '\u001b[?1049h',
      tail: 'full screen paint',
    })
    await microtasks()
    expect(panes[0]?.writes).toEqual(['\u001b[?1049h', 'full screen paint'])
    mount.dispose()
  })

  it('writes frames queued while the pane loads in order, then live frames', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount, host } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 30, tail: 'tail' })
    mount.handle({ type: 'output', handle: ROW, data: 'queued' })
    mount.handle({ type: 'geometry', handle: ROW, cols: 90, rows: 20 })
    expect(panes[0]?.writes).toEqual([])
    await microtasks()
    expect(panes[0]?.writes).toEqual(['tail', 'queued'])
    expect(panes[0]?.resizes).toEqual([{ cols: 90, rows: 20 }])
    expect(panes[0]?.mounted).toBe(host.querySelector('.companion-terminal-grid'))
    expect(panes[0]?.mounted?.parentElement?.className).toBe('companion-terminal-scale')
    mount.handle({ type: 'output', handle: ROW, data: 'live' })
    expect(panes[0]?.writes).toEqual(['tail', 'queued', 'live'])
    mount.dispose()
    expect(panes[0]?.disposed).toBe(true)
    expect(host.querySelector('.companion-terminal-extent')).toBeNull()
  })

  it('a pane that throws while mounting reports the failure and is disposed', async () => {
    const failure = new Error('bad sequence')
    class ThrowingPane extends FakeCompanionPane {
      override write(): void {
        throw failure
      }
    }
    const panes: ThrowingPane[] = []
    const { mount, host, failures } = mountWith((cols, rows) => {
      const pane = new ThrowingPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({ type: 'opened', handle: ROW, cols: 80, rows: 24, tail: 'tail' })
    await microtasks()
    expect(failures).toEqual([failure])
    expect(panes[0]?.disposed).toBe(true)
    expect(host.querySelector('.fake-pane')).toBeNull()
    // Nothing holds the failed pane: later frames are dropped rather than written.
    mount.handle({ type: 'output', handle: ROW, data: 'after' })
    expect(panes[0]?.writes).toEqual([])
    mount.dispose()
  })

  it('a pane factory rejection reaches the same failure path once', async () => {
    const failure = new Error('module missing')
    const { mount, failures } = mountWith(() => Promise.reject(failure))
    mount.handle({ type: 'opened', handle: ROW, cols: 80, rows: 24, tail: '' })
    await microtasks()
    expect(failures).toEqual([failure])
    mount.dispose()
  })

  it('scales the desktop grid to the host width as a transform and sizes the extent, never the pane', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount, host } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    const surface = host.querySelector<HTMLElement>('.companion-terminal-scale')
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')
    expect(surface?.style.transform).toBe('scale(0.5)')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '320px'])

    // A wider desktop grid scales further down; the rows may run past the host, which scrolls.
    mount.handle({ type: 'geometry', handle: ROW, cols: 200, rows: 40 })
    expect(surface?.style.transform).toBe('scale(0.25)')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '160px'])
    expect(panes[0]?.resizes).toEqual([{ cols: 200, rows: 40 }])
    expect(host.style.height).toBe('')
    mount.dispose()
  })

  it('draws the scrollback above the grid at its cell metrics and grows the extent with it', async () => {
    vi.useFakeTimers()
    try {
      const panes: FakeCompanionPane[] = []
      const { mount, host } = mountWith((cols, rows) => {
        const pane = new FakeCompanionPane(cols, rows)
        pane.lines = [
          { text: 'old one', wrapped: false },
          { text: 'old two ', wrapped: false },
          { text: 'screen 1', wrapped: false },
          { text: 'screen 2', wrapped: false },
        ]
        panes.push(pane)
        return Promise.resolve(pane)
      })
      layout(host, 400, 1000)
      const history = host.querySelector<HTMLElement>('.companion-terminal-history')!
      // happy-dom lays nothing out: the history reports its rows at the cell height.
      Object.defineProperty(history, 'offsetHeight', {
        get: () => (history.textContent ?? '').split('\n').length * 16,
      })
      mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 2, tail: 'tail' })
      await vi.advanceTimersByTimeAsync(0)

      // The screen's own rows stay in the grid; every row before them is the history.
      expect(history.textContent).toBe('old one\nold two ')
      expect(history.style.fontFamily).toBe('Menlo')
      expect(history.style.fontSize).toBe('15px')
      expect(history.style.lineHeight).toBe('16px')
      expect(panes[0]?.reads).toEqual([HISTORY_LINE_LIMIT + 2])
      const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')
      expect(
        host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform,
      ).toBe('scale(0.5)')
      expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '32px'])

      // Output grows the history on the next interval and the extent with it.
      panes[0]!.lines = [
        { text: 'old one', wrapped: false },
        { text: 'old two ', wrapped: false },
        { text: 'old three', wrapped: false },
        { text: 'screen 1', wrapped: false },
        { text: 'screen 2', wrapped: false },
      ]
      mount.handle({ type: 'output', handle: ROW, data: 'a' })
      mount.handle({ type: 'output', handle: ROW, data: 'b' })
      expect(history.textContent).toBe('old one\nold two ')
      await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_MS)
      expect(history.textContent).toBe('old one\nold two \nold three')
      expect(extent?.style.height).toBe('40px')
      expect(panes[0]?.resizes).toEqual([])
      mount.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CompanionTerminalMount while the desktop is Away (ADR-052)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks for the phone grid once after opening and renders it unscaled when it lands', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, resizes, answers } = mountWith(create, {
      outcome: 'refused',
      reason: 'desktop-focused',
    })
    layout(host, 376, 496)
    mount.setAway(true)
    mount.handle({ type: 'opened', handle: ROW, cols: 132, rows: 43, tail: '' })
    await vi.advanceTimersByTimeAsync(0)
    const surface = host.querySelector<HTMLElement>('.companion-terminal-scale')!
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')!
    expect(resizes).toEqual([])
    expect(surface.style.transform).toBe(`scale(${376 / (132 * 8)})`)

    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS)
    expect(resizes).toEqual([{ cols: 47, rows: 31 }])
    expect(answers).toEqual([{ outcome: 'refused', reason: 'desktop-focused' }])
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 4)
    expect(resizes).toHaveLength(1)
    // The grid is still the desktop's until main says otherwise.
    expect(panes[0]?.resizes).toEqual([])
    expect(surface.style.transform).toBe(`scale(${376 / (132 * 8)})`)

    mount.handle({ type: 'geometry', handle: ROW, cols: 47, rows: 31 })
    expect(panes[0]?.resizes).toEqual([{ cols: 47, rows: 31 }])
    expect(surface.style.transform).toBe('scale(1)')
    expect([extent.style.width, extent.style.height]).toEqual(['376px', '496px'])

    // The desktop reclaimed: back to the scaled column, and nothing is asked again by itself.
    mount.handle({ type: 'geometry', handle: ROW, cols: 132, rows: 43 })
    expect(surface.style.transform).toBe(`scale(${376 / (132 * 8)})`)
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 2)
    expect(resizes).toHaveLength(1)
    expect(answers).toHaveLength(1)
    mount.dispose()
  })

  it('a held grid whose cells round past the host width shrinks a hair rather than clipping a column', async () => {
    const { create } = fakePanes()
    const { mount, host } = mountWith(create)
    // 47 fake cells are 376px wide; the host is one pixel narrower.
    layout(host, 375, 496)
    mount.setAway(true)
    mount.handle({ type: 'opened', handle: ROW, cols: 47, rows: 31, tail: '' })
    await vi.advanceTimersByTimeAsync(0)
    const surface = host.querySelector<HTMLElement>('.companion-terminal-scale')!
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')!
    expect(surface.style.transform).toBe(`scale(${375 / 376})`)
    expect(extent.style.width).toBe('375px')
    mount.dispose()
  })

  it('asks nothing while the desktop is focused, once when it goes Away, and nothing after ended', async () => {
    const { create } = fakePanes()
    const { mount, host, resizes } = mountWith(create)
    layout(host, 376, 496)
    mount.handle({ type: 'opened', handle: ROW, cols: 132, rows: 43, tail: '' })
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 2)
    expect(resizes).toEqual([])

    mount.setAway(true)
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS)
    expect(resizes).toEqual([{ cols: 47, rows: 31 }])

    mount.handle({ type: 'ended', handle: ROW, reason: 'exited' })
    mount.setAway(false)
    mount.setAway(true)
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS * 2)
    expect(resizes).toHaveLength(1)
    mount.dispose()
  })

  it('a settled area change asks again, and a change that fits the same grid does not', async () => {
    const observer = observedResizes()
    const { create } = fakePanes()
    const { mount, host, resizes } = mountWith(create)
    layout(host, 376, 496)
    mount.setAway(true)
    mount.handle({ type: 'opened', handle: ROW, cols: 132, rows: 43, tail: '' })
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS)
    expect(resizes).toEqual([{ cols: 47, rows: 31 }])

    layout(host, 383, 500)
    observer.fire()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS)
    expect(resizes).toHaveLength(1)

    layout(host, 240, 320)
    observer.fire()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 1)
    layout(host, 240, 336)
    observer.fire()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 1)
    expect(resizes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(resizes).toEqual([
      { cols: 47, rows: 31 },
      { cols: 30, rows: 21 },
    ])
    mount.dispose()
    observer.fire()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS)
    expect(resizes).toHaveLength(2)
  })
})
