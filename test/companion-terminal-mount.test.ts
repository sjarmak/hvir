// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

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
): {
  readonly mount: CompanionTerminalMount
  readonly host: HTMLDivElement
  readonly failures: unknown[]
  readonly inputs: string[]
  readonly alternates: boolean[]
  readonly readingBacks: boolean[]
} {
  const host = document.createElement('div')
  document.body.append(host)
  const failures: unknown[] = []
  const inputs: string[] = []
  const alternates: boolean[] = []
  const readingBacks: boolean[] = []
  const mount = new CompanionTerminalMount({
    host,
    createPane: create,
    onInput: (data) => inputs.push(data),
    onAlternateScreen: (alternate) => alternates.push(alternate),
    onReadingBack: (readingBack) => readingBacks.push(readingBack),
    onFailure: (error) => failures.push(error),
  })
  return { mount, host, failures, inputs, alternates, readingBacks }
}

/**
 * One finger over the grid, in on-screen pixels as a browser reports them. The
 * clock stands still across it, so the lift has no speed behind it and ends
 * the gesture then rather than flinging on (companion-touch-scroll.test.ts
 * covers the fling).
 */
function dragGrid(within: HTMLElement, from: number, to: number): void {
  const grid = within.matches('.companion-terminal-grid')
    ? within
    : within.querySelector('.companion-terminal-grid')
  if (grid === null) throw new Error('missing grid box')
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000)
  try {
    for (const [type, clientY] of [
      ['touchstart', from],
      ['touchmove', to],
      ['touchend', to],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'changedTouches', {
        value: [{ identifier: 1, clientX: 0, clientY }],
      })
      grid.dispatchEvent(event)
    }
  } finally {
    clock.mockRestore()
  }
}

/** happy-dom lays nothing out: the host's size is stated for the fit. */
function layout(host: HTMLElement, width: number, height: number): void {
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => height })
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

/**
 * A pane whose own write moves the viewport, the way output landing while the
 * emulator holds a read-back position advances it. The mount hears it only if
 * it subscribed before it wrote.
 */
class MovingPane extends FakeCompanionPane {
  override write(data: string): void {
    super.write(data)
    this.moveViewport(this.offset + 3)
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

  it('a finger over the grid reaches the pane in the emulator pixels the scale hides', async () => {
    const { panes, create } = fakePanes()
    const { mount, host } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    expect(
      host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform,
    ).toBe('scale(0.5)')
    dragGrid(host, 200, 160)
    expect(panes[0]?.gestures.map((gesture) => gesture.deltaY)).toEqual([80])
    mount.dispose()

    // The same forty on-screen pixels over an unscaled grid are forty emulator pixels.
    const unscaled = fakePanes()
    const second = mountWith(unscaled.create)
    layout(second.host, 800, 640)
    second.mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    expect(
      second.host.querySelector<HTMLElement>('.companion-terminal-scale')?.style
        .transform,
    ).toBe('scale(1)')
    dragGrid(second.host, 200, 160)
    expect(unscaled.panes[0]?.gestures.map((gesture) => gesture.deltaY)).toEqual([40])
    second.mount.dispose()
  })

  it('a gesture the viewport cannot take scrolls the host over an overflowing extent', async () => {
    const { panes, create } = fakePanes()
    const { mount, host } = mountWith(create)
    layout(host, 400, 320)
    // A hundred rows at the fake cell scale to an extent well past the host.
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 100, tail: '' })
    await microtasks()
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '800px'])
    expect(Number.parseInt(extent?.style.height ?? '0', 10)).toBeGreaterThan(
      host.clientHeight,
    )

    panes[0]!.untaken = 80
    dragGrid(host, 200, 160)
    expect(panes[0]?.gestures.map((gesture) => gesture.deltaY)).toEqual([80])
    // Forty on-screen pixels of finger, the same forty pixels of host.
    expect(host.scrollTop).toBe(40)

    // A pane that takes the gesture leaves the host where it is.
    panes[0]!.untaken = 0
    dragGrid(host, 200, 160)
    expect(host.scrollTop).toBe(40)
    mount.dispose()
  })

  it('the host comes back up the way it went down, ahead of the viewport', async () => {
    const { panes, create } = fakePanes()
    const { mount, host } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 100, tail: '' })
    await microtasks()

    // Down to the bottom of a grid twice the host's height: the viewport is at
    // the live edge, so the whole gesture reaches the host.
    panes[0]!.untaken = 80
    for (let index = 0; index < 20; index += 1) dragGrid(host, 200, 160)
    expect(host.scrollTop).toBe(480)
    const afterDown = panes[0]!.gestures.length

    // Back toward older content: the host is what lies that way, so it gives
    // its travel back before the pane's scrollback is asked for any.
    dragGrid(host, 160, 200)
    expect(host.scrollTop).toBe(440)
    expect(panes[0]?.gestures).toHaveLength(afterDown)

    for (let index = 0; index < 12; index += 1) dragGrid(host, 160, 200)
    expect(host.scrollTop).toBe(0)
    // Only once the host is pinned does the gesture reach the emulator.
    expect(panes[0]?.gestures.length).toBeGreaterThan(afterDown)
    expect(panes[0]?.gestures.at(-1)?.deltaY).toBe(-80)
    mount.dispose()
  })

  it('a full-screen program taking the gesture as keys still leaves the host reachable', async () => {
    const { panes, create } = fakePanes()
    const { mount, host } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 100, tail: '' })
    await microtasks()
    panes[0]!.alternateScreen = true
    // The pane sends page keys and moves no pixel of its own, so it hands the
    // whole travel back and the rows below the fold stay reachable.
    panes[0]!.untaken = 80
    dragGrid(host, 200, 160)
    expect(host.scrollTop).toBe(40)
    mount.dispose()
  })

  it('the lift of the finger ends the gesture for the pane', async () => {
    const { panes, create } = fakePanes()
    const { mount, host } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    dragGrid(host, 200, 160)
    expect(panes[0]!.gestures).toHaveLength(1)
    expect(panes[0]!.gestureEnds).toBe(1)
    mount.dispose()
  })

  it('a disposed mount owns the grid no longer', async () => {
    const { create } = fakePanes()
    const { mount, host } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 100, tail: '' })
    await microtasks()
    const grid = host.querySelector<HTMLElement>('.companion-terminal-grid')!
    // ghostty-web's own canvas listener sits under the grid; the adapter stops
    // every touchend above it while it lives, and nothing after it is disposed.
    const past: string[] = []
    grid.parentElement?.addEventListener('touchend', () => past.push('touchend'))
    dragGrid(host, 200, 160)
    expect(past).toEqual([])
    mount.dispose()
    dragGrid(grid, 200, 160)
    expect(past).toEqual(['touchend'])
  })

  it('reports the screen the emulator is on so the page can state it has no history', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, alternates } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    // Stated rather than assumed: a view holding the notice from an earlier
    // mirror is corrected by the first report, not left to a later change.
    expect(alternates).toEqual([false])

    panes[0]!.alternateScreen = true
    mount.handle({ type: 'output', handle: ROW, data: 'full screen paint' })
    expect(alternates).toEqual([false, true])
    mount.handle({ type: 'output', handle: ROW, data: 'more of it' })
    expect(alternates).toEqual([false, true])

    panes[0]!.alternateScreen = false
    mount.handle({ type: 'output', handle: ROW, data: 'back to the shell' })
    expect(alternates).toEqual([false, true, false])
    mount.dispose()
  })

  it('a geometry frame that changes the screen reports it without waiting for output', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, alternates } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.alternateScreen = true
    mount.handle({ type: 'geometry', handle: ROW, cols: 90, rows: 30 })
    expect(alternates).toEqual([false, true])
    mount.dispose()
  })

  it('a session that ends and one that reopens both leave no notice standing', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, alternates } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.alternateScreen = true
    mount.handle({ type: 'output', handle: ROW, data: 'full screen paint' })
    expect(alternates).toEqual([false, true])

    mount.handle({ type: 'ended', handle: ROW, reason: 'exited' })
    expect(alternates).toEqual([false, true, false])

    panes[0]!.alternateScreen = true
    mount.handle({ type: 'output', handle: ROW, data: 'still painting' })
    expect(alternates).toEqual([false, true, false, true])
    // A fresh mirror says so before its pane has even loaded.
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    expect(alternates).toEqual([false, true, false, true, false])
    mount.dispose()
  })

  it('states the viewport is at the live edge without waiting for it to move', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    // The emulator fires nothing at construction, so the first word is read.
    expect(readingBacks).toEqual([false])
    expect(panes[0]?.viewportSubscriptions()).toBe(1)
    mount.dispose()
  })

  it('a viewport moved by the queued frames themselves is reported, not missed', async () => {
    const panes: MovingPane[] = []
    const { mount, host, readingBacks } = mountWith((cols, rows) => {
      const pane = new MovingPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    layout(host, 400, 320)
    // The subscription is in place before the preamble and the tail are
    // written, so a pane whose own write moves the viewport is heard.
    mount.handle({
      type: 'opened',
      handle: ROW,
      cols: 100,
      rows: 40,
      preamble: '\x1b[?1049h',
      tail: 'earlier output',
    })
    await microtasks()
    expect(panes[0]?.writes).toEqual(['\x1b[?1049h', 'earlier output'])
    expect(readingBacks).toEqual([false, true])
    mount.dispose()
  })

  it('reports the viewport leaving the live edge and reaching it again, once each', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.moveViewport(6)
    expect(readingBacks).toEqual([false, true])
    // Further back, and a fraction of a row short of live: still read back.
    panes[0]!.moveViewport(40)
    panes[0]!.moveViewport(0.4)
    expect(readingBacks).toEqual([false, true])
    panes[0]!.moveViewport(0)
    expect(readingBacks).toEqual([false, true, false])
    mount.dispose()
  })

  it('the way back reaches the pane and nothing else', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.moveViewport(6)
    mount.returnToLive()
    expect(panes[0]?.returns).toBe(1)
    expect(readingBacks).toEqual([false, true, false])
    expect(panes[0]?.writes).toEqual([''])
    mount.dispose()
  })

  it('the way back travels the whole strip over a grid taller than the host', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    // A hundred rows scale to an 800px extent in a 320px host: 480px of the
    // grid, the newest rows among them, live below the fold.
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 100, tail: '' })
    await microtasks()

    panes[0]!.untaken = 80
    for (let index = 0; index < 20; index += 1) dragGrid(host, 200, 160)
    expect(host.scrollTop).toBe(480)
    // Toward older output the host gives back its travel first, so by the time
    // the viewport leaves the live edge the host is at the top of the grid.
    for (let index = 0; index < 13; index += 1) dragGrid(host, 160, 200)
    expect(host.scrollTop).toBe(0)
    panes[0]!.moveViewport(40)
    expect(readingBacks).toEqual([false, true])

    mount.returnToLive()
    expect(panes[0]?.returns).toBe(1)
    expect(readingBacks).toEqual([false, true, false])
    // Both scrollers home: the viewport on the newest output and the host at
    // the bottom of the grid that holds it, which is what one tap promises.
    expect(host.scrollTop).toBe(480)
    mount.dispose()
  })

  it('the way back leaves a grid the host already holds whole where it is', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 20, tail: '' })
    await microtasks()
    panes[0]!.moveViewport(6)
    mount.returnToLive()
    expect(readingBacks).toEqual([false, true, false])
    // A 160px extent inside a 320px host has no travel to run.
    expect(host.scrollTop).toBe(0)
    mount.dispose()
  })

  it('a reflow that re-anchors a held viewport is followed rather than reported stale', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.moveViewport(320)
    expect(readingBacks).toEqual([false, true])
    // The desktop publishes a narrower grid; the reflow leaves fewer rows
    // behind the live edge than the viewport held, and the pane re-anchors to
    // the oldest row that is left. Still behind the newest output, so the way
    // back stands: only an emptied scrollback re-anchors all the way to live.
    panes[0]!.reflowOffset = 80
    mount.handle({ type: 'geometry', handle: ROW, cols: 47, rows: 31 })
    expect(readingBacks).toEqual([false, true])

    panes[0]!.reflowOffset = 0
    mount.handle({ type: 'geometry', handle: ROW, cols: 40, rows: 24 })
    expect(readingBacks).toEqual([false, true, false])
    mount.dispose()
  })

  it('a session that ends keeps the way back while the viewport is still behind it', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.moveViewport(6)
    mount.handle({ type: 'ended', handle: ROW, reason: 'exited' })
    // The emulator still holds the screen, so the newest output is still
    // somewhere to get back to and the control must not vanish under a finger.
    expect(readingBacks).toEqual([false, true])
    mount.returnToLive()
    expect(panes[0]?.returns).toBe(1)
    expect(readingBacks).toEqual([false, true, false])
    mount.dispose()
  })

  it('a fresh mirror and a disposed one both leave no way back standing', async () => {
    const { panes, create } = fakePanes()
    const { mount, host, readingBacks } = mountWith(create)
    layout(host, 400, 320)
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    panes[0]!.moveViewport(6)
    expect(readingBacks).toEqual([false, true])

    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    expect(readingBacks).toEqual([false, true, false])
    // The replaced pane is nobody's: its viewport moves reach no one.
    expect(panes[0]?.viewportSubscriptions()).toBe(0)
    panes[0]!.moveViewport(9)
    expect(readingBacks).toEqual([false, true, false])

    await microtasks()
    panes[1]!.moveViewport(9)
    expect(readingBacks).toEqual([false, true, false, true])
    mount.dispose()
    expect(panes[1]?.viewportSubscriptions()).toBe(0)
    panes[1]!.moveViewport(0)
    expect(readingBacks).toEqual([false, true, false, true])
  })
})
