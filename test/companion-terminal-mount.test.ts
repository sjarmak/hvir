// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

import {
  HISTORY_LINE_LIMIT,
  REFLOW_LINE_LIMIT,
  REFLOW_REFRESH_MS,
} from '../src/renderer/companion/src/companion-mirror-reflow'
import { CompanionTerminalMount } from '../src/renderer/companion/src/companion-terminal-mount'
import type { CompanionTerminalPane } from '../src/renderer/companion/src/companion-terminal-pane'
import { asSessionsTerminalHandle } from '../src/shared'
import { FakeCompanionPane } from './companion-page-fixture'

const ROW = asSessionsTerminalHandle('row-1')

async function microtasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountWith(
  create: (cols: number, rows: number) => Promise<CompanionTerminalPane>,
): {
  readonly mount: CompanionTerminalMount
  readonly host: HTMLDivElement
  readonly failures: unknown[]
  readonly inputs: string[]
} {
  const host = document.createElement('div')
  document.body.append(host)
  const failures: unknown[] = []
  const inputs: string[] = []
  const mount = new CompanionTerminalMount(
    host,
    create,
    (data) => inputs.push(data),
    (error) => failures.push(error),
  )
  return { mount, host, failures, inputs }
}

describe('CompanionTerminalMount', () => {
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

  it('zoom scales the desktop grid as a transform and sizes the extent, never the pane', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount, host } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    Object.defineProperty(host, 'clientWidth', { get: () => 400 })
    Object.defineProperty(host, 'clientHeight', { get: () => 320 })
    const surface = host.querySelector<HTMLElement>('.companion-terminal-scale')
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')

    mount.setZoom('fill-height')
    expect(surface?.style.transform).toBe('scale(0.5)')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '320px'])

    mount.setZoom('fit-width')
    expect(surface?.style.transform).toBe('scale(0.5)')
    mount.handle({ type: 'geometry', handle: ROW, cols: 200, rows: 40 })
    expect(surface?.style.transform).toBe('scale(0.25)')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '160px'])
    expect(panes[0]?.resizes).toEqual([{ cols: 200, rows: 40 }])
    expect(host.style.height).toBe('')
    mount.dispose()
  })

  it('a touch drag over the host in fill-height scrolls the pane by rows of the scaled grid', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount, host } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    Object.defineProperty(host, 'clientWidth', { get: () => 400 })
    Object.defineProperty(host, 'clientHeight', { get: () => 320 })
    mount.setZoom('fill-height')
    const drag = (type: string, clientY: number): boolean =>
      host.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'touch',
          clientY,
          bubbles: true,
        }),
      )
    drag('pointerdown', 100)
    drag('pointermove', 76)
    drag('pointerup', 76)
    expect(panes[0]?.scrolls).toEqual([3])
    mount.dispose()
    drag('pointerdown', 100)
    drag('pointermove', 76)
    expect(panes[0]?.scrolls).toEqual([3])
  })

  it('fit-width draws the scrollback above the grid at its cell metrics and scrolls the two as one', async () => {
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
      Object.defineProperty(host, 'clientWidth', { get: () => 400 })
      Object.defineProperty(host, 'clientHeight', { get: () => 1000 })
      const history = host.querySelector<HTMLElement>('.companion-terminal-history')!
      // happy-dom lays nothing out: the history reports two rows at the cell height.
      Object.defineProperty(history, 'offsetWidth', { get: () => 800 })
      Object.defineProperty(history, 'offsetHeight', {
        get: () => (history.textContent ?? '').split('\n').length * 16,
      })
      mount.setZoom('fit-width')
      mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 2, tail: 'tail' })
      await vi.advanceTimersByTimeAsync(0)

      // The screen's own rows stay in the grid; every row before them is the history.
      expect(history.hidden).toBe(false)
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
      await vi.advanceTimersByTimeAsync(REFLOW_REFRESH_MS)
      expect(history.textContent).toBe('old one\nold two \nold three')
      expect(extent?.style.height).toBe('40px')

      // A touch drag is the host's own scroll here, never rows sent to the pane.
      const drag = (type: string, clientY: number): boolean =>
        host.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: 'touch',
            clientY,
            bubbles: true,
          }),
        )
      drag('pointerdown', 100)
      drag('pointermove', 20)
      drag('pointerup', 20)
      expect(panes[0]?.scrolls).toEqual([])

      // Fill-height shows the grid alone.
      mount.setZoom('fill-height')
      expect(history.hidden).toBe(true)
      expect(extent?.style.height).toBe('1000px')
      expect(panes[0]?.resizes).toEqual([])
      mount.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the reflow view shows the pane text as a page, hides the grid, and takes no drags', async () => {
    vi.useFakeTimers()
    try {
      const panes: FakeCompanionPane[] = []
      const { mount, host } = mountWith((cols, rows) => {
        const pane = new FakeCompanionPane(cols, rows)
        pane.lines = [
          { text: 'first  ', wrapped: false },
          { text: 'line', wrapped: true },
        ]
        panes.push(pane)
        return Promise.resolve(pane)
      })
      const page = host.querySelector<HTMLElement>('.companion-terminal-reflow')
      const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')
      expect(page?.hidden).toBe(false)
      expect(extent?.hidden).toBe(true)

      mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: 'tail' })
      await vi.advanceTimersByTimeAsync(0)
      expect(page?.textContent).toBe('first  line')
      expect(panes[0]?.reads).toEqual([REFLOW_LINE_LIMIT])

      // Output refreshes the page once per interval, from the pane's current rows.
      panes[0]!.lines = [
        { text: 'first', wrapped: false },
        { text: 'second', wrapped: false },
      ]
      mount.handle({ type: 'output', handle: ROW, data: 'a' })
      mount.handle({ type: 'output', handle: ROW, data: 'b' })
      expect(page?.textContent).toBe('first  line')
      await vi.advanceTimersByTimeAsync(REFLOW_REFRESH_MS)
      expect(page?.textContent).toBe('first\nsecond')
      expect(panes[0]?.reads).toHaveLength(2)

      const drag = (type: string, clientY: number): boolean =>
        host.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: 'touch',
            clientY,
            bubbles: true,
          }),
        )
      drag('pointerdown', 100)
      drag('pointermove', 20)
      drag('pointerup', 20)
      expect(panes[0]?.scrolls).toEqual([])

      // A grid view puts the grid back and stops refreshing the page.
      Object.defineProperty(host, 'clientWidth', { get: () => 400 })
      Object.defineProperty(host, 'clientHeight', { get: () => 320 })
      mount.setZoom('fit-width')
      expect(page?.hidden).toBe(true)
      expect(extent?.hidden).toBe(false)
      expect(
        host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform,
      ).toBe('scale(0.5)')
      panes[0]!.lines = [{ text: 'third', wrapped: false }]
      mount.handle({ type: 'output', handle: ROW, data: 'c' })
      await vi.advanceTimersByTimeAsync(REFLOW_REFRESH_MS)
      expect(page?.textContent).toBe('first\nsecond')

      mount.setZoom('reflow')
      expect(page?.textContent).toBe('third')
      expect(panes[0]?.resizes).toEqual([])
      mount.dispose()
      expect(host.querySelector('.companion-terminal-reflow')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
