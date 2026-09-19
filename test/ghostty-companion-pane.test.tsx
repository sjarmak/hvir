// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyCompanionPane } from '../src/renderer/companion/src/ghostty-companion-pane'
import type { TerminalWheelEvent } from '../src/shared'

interface FakeTerminalState {
  readonly options: Record<string, unknown>
  readonly writes: string[]
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>
  readonly scrolls: number[]
  /** Lines `scrollToLine` was sent, which is how the pane re-anchors after a reflow. */
  readonly anchors: number[]
  /** Lines the viewport sits behind the live edge, clamped as ghostty clamps it. */
  viewportY: number
  scrollbackLength: number
  /** What the next `resize` reflows the scrollback down to, so the reflow is what shortens it. */
  reflowedScrollbackLength?: number
  onResizeSubscriptions: number
  opened?: HTMLElement
  disposed: boolean
  alternateScreen: boolean
  mouseTracking: boolean
  sgrMouse: boolean
  /** Fires the terminal's own reply synchronously inside the next write. */
  replyOnWrite?: string
  wheelHandler?: (event: WheelEvent) => boolean
  emitData: (data: string) => void
}

const fakes: FakeTerminalState[] = []
const initCalls = vi.hoisted(() => ({ urls: [] as string[] }))

vi.mock('ghostty-web', () => {
  class Terminal {
    readonly options: Record<string, unknown>
    readonly cols: number
    readonly rows: number
    private readonly dataListeners = new Set<(data: string) => void>()
    private readonly state: FakeTerminalState
    element?: HTMLElement

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      this.cols = Number(options['cols'])
      this.rows = Number(options['rows'])
      const state: FakeTerminalState = {
        options: this.options,
        writes: [],
        resizes: [],
        scrolls: [],
        anchors: [],
        viewportY: 0,
        scrollbackLength: 0,
        onResizeSubscriptions: 0,
        disposed: false,
        alternateScreen: false,
        mouseTracking: false,
        sgrMouse: false,
        emitData: (data) => {
          for (const listener of this.dataListeners) listener(data)
        },
      }
      this.state = state
      fakes.push(state)
    }

    readonly wasmTerm = {
      isAlternateScreen: () => this.state.alternateScreen,
      hasMouseTracking: () => this.state.mouseTracking,
      getMode: () => this.state.sgrMouse,
    }

    readonly renderer = { charWidth: 8, charHeight: 16 }

    readonly onData = (listener: (data: string) => void) => {
      this.dataListeners.add(listener)
      return { dispose: () => this.dataListeners.delete(listener) }
    }

    readonly onResize = () => {
      this.state.onResizeSubscriptions += 1
      return { dispose: () => undefined }
    }

    open(parent: HTMLElement): void {
      this.element = document.createElement('div')
      this.element.className = 'fake-ghostty'
      parent.append(this.element)
      this.state.opened = parent
    }

    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
      this.state.wheelHandler = handler
    }

    write(data: string): void {
      this.state.writes.push(data)
      const reply = this.state.replyOnWrite
      if (reply !== undefined) this.state.emitData(reply)
    }

    // A reflow at a new grid retains a different number of rows behind the
    // live edge and leaves viewportY exactly where it was.
    resize(cols: number, rows: number): void {
      this.state.resizes.push({ cols, rows })
      const reflowed = this.state.reflowedScrollbackLength
      if (reflowed !== undefined) this.state.scrollbackLength = reflowed
    }

    // ghostty clamps `viewportY - amount` into the scrollback, so a positive
    // amount walks toward the live edge at 0 (ghostty-web.js:5056-5062).
    scrollLines(amount: number): void {
      this.state.scrolls.push(amount)
      this.state.viewportY = this.clamp(this.state.viewportY - amount)
    }

    scrollToLine(line: number): void {
      this.state.anchors.push(line)
      this.state.viewportY = this.clamp(line)
    }

    getViewportY(): number {
      return this.state.viewportY
    }

    getScrollbackLength(): number {
      return this.state.scrollbackLength
    }

    private clamp(line: number): number {
      return Math.max(0, Math.min(this.state.scrollbackLength, line))
    }

    dispose(): void {
      this.state.disposed = true
      this.element?.remove()
    }
  }
  return {
    Terminal,
    init: (options: { wasmUrl: string }) => {
      initCalls.urls.push(String(options.wasmUrl))
      return Promise.resolve()
    },
  }
})

const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'

beforeEach(() => {
  fakes.splice(0)
})

afterEach(() => {
  document.body.replaceChildren()
})

function wheel(fake: FakeTerminalState, deltaY: number): boolean {
  if (fake.wheelHandler === undefined) throw new Error('no wheel handler attached')
  return fake.wheelHandler(new WheelEvent('wheel', { deltaY, deltaMode: 0 }))
}

/** One move of a finger over the grid, already in the emulator's own pixels. */
function drag(deltaY: number): TerminalWheelEvent {
  return {
    deltaY,
    deltaMode: 0,
    offsetX: 0,
    offsetY: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
  }
}

describe('ghostty companion pane', () => {
  it('constructs the terminal at the desktop geometry with input off and no fit', async () => {
    const pane = await createGhosttyCompanionPane(132, 43)
    const fake = fakes[0]!
    expect(fake.options).toMatchObject({
      cols: 132,
      rows: 43,
      disableStdin: true,
      focusOnOpen: false,
      disableContextMenu: true,
    })
    const host = document.createElement('div')
    pane.mount(host)
    expect(fake.opened).toBe(host)
    pane.dispose()
    expect(fake.disposed).toBe(true)
  })

  it('draws a fixed readable font and reports its cell size from the renderer (ADR-052)', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    expect(fake.options['fontSize']).toBe(15)
    pane.mount(document.createElement('div'))
    expect(pane.cellSize()).toEqual({ width: 8, height: 16 })
  })

  it('data emitted during write never reaches onData', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    pane.setInputEnabled(true)
    const seen: string[] = []
    pane.events.onData((data, source) => seen.push(`${source}:${data}`))
    fake.replyOnWrite = '[?1;2c'
    pane.write('[c')
    expect(fake.writes).toEqual(['[c'])
    expect(seen).toEqual([])
    fake.emitData('\r')
    expect(seen).toEqual(['user:\r'])
  })

  it('data is dropped while input is disabled and flows once enabled, read live per key', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    fake.emitData('a')
    expect(seen).toEqual([])
    expect(fake.options['disableStdin']).toBe(true)
    pane.setInputEnabled(true)
    expect(fake.options['disableStdin']).toBe(false)
    fake.emitData('b')
    pane.setInputEnabled(false)
    fake.emitData('c')
    expect(seen).toEqual(['b'])
  })

  it('resize follows the desktop and never subscribes onResize', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    pane.resize(200, 50)
    expect(fake.resizes).toEqual([{ cols: 200, rows: 50 }])
    expect(fake.onResizeSubscriptions).toBe(0)
    expect(fake.anchors).toEqual([])
  })

  it('a resize whose reflow shortens the scrollback re-anchors the held viewport', async () => {
    const pane = await createGhosttyCompanionPane(132, 43)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.scrollbackLength = 400
    fake.viewportY = 320
    // The grid the desktop published narrows, and the reflow that the resize
    // performs leaves fewer rows behind the live edge than the viewport holds.
    fake.reflowedScrollbackLength = 120
    pane.resize(47, 31)
    expect(fake.anchors).toEqual([120])
    expect(fake.viewportY).toBe(120)
  })

  it('a drag toward the bottom of the screen reads back into the scrollback', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.scrollbackLength = 500
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    // A finger toward the bottom reveals older content: the viewport walks
    // away from the live edge at 0, so the amount ghostty is given is negative.
    expect(pane.scroll(drag(-32))).toBe(0)
    expect(fake.scrolls).toEqual([-2])
    expect(fake.viewportY).toBe(2)
    expect(seen).toEqual([])
  })

  it('a drag toward the top of the screen reads forward to the live edge', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.scrollbackLength = 500
    fake.viewportY = 10
    expect(pane.scroll(drag(48))).toBe(0)
    expect(fake.scrolls).toEqual([3])
    expect(fake.viewportY).toBe(7)
  })

  it('a drag shorter than a cell is kept and lands once it adds up', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.scrollbackLength = 500
    expect(pane.scroll(drag(-6))).toBe(0)
    expect(pane.scroll(drag(-6))).toBe(0)
    expect(fake.scrolls).toEqual([])
    expect(pane.scroll(drag(-6))).toBe(0)
    expect(fake.scrolls).toEqual([-1])
  })

  it('a gesture the viewport is already at the edge for hands back every pixel', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    // No scrollback: a normal-screen session that has written nothing yet.
    expect(pane.scroll(drag(-64))).toBe(-64)
    expect(fake.scrolls).toEqual([])
    expect(fake.viewportY).toBe(0)
  })

  it('sub-cell drags at the edge hand back their whole travel rather than banking it', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    // A slow finger over a session at the live edge: every move is short of one
    // cell, and the page's own scroller must still track all eighteen pixels.
    const answers = [pane.scroll(drag(-6)), pane.scroll(drag(-6)), pane.scroll(drag(-6))]
    expect(answers).toEqual([-6, -6, -6])
    expect(fake.scrolls).toEqual([])
  })

  it('a drag that runs past the oldest row hands back only the part beyond it', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.scrollbackLength = 2
    // Four cells of finger against two rows of scrollback: two rows are taken
    // and the remaining two cells, 32 pixels, go back to the page.
    expect(pane.scroll(drag(-64))).toBe(-32)
    expect(fake.viewportY).toBe(2)
  })

  it('a drag on the alternate screen sends one page key and moves no viewport', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    fake.scrollbackLength = 500
    pane.setInputEnabled(true)
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    // The program answers the gesture in its own terms; this surface moved no
    // pixel, so the whole travel is the page's to scroll a too-tall grid with.
    expect(pane.scroll(drag(-96))).toBe(-96)
    expect(seen).toEqual([PAGE_UP])
    expect(fake.scrolls).toEqual([])
    expect(fake.viewportY).toBe(0)
  })

  it('a disarmed mirror sends nothing from a drag on the alternate screen', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    expect(pane.scroll(drag(-96))).toBe(-96)
    expect(seen).toEqual([])
    expect(fake.scrolls).toEqual([])
  })

  it('a disarmed mirror under a mouse-tracking program still reads back', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    // A program on the normal screen that asked for mouse reports, on the
    // default disarmed mirror: the policy claims the gesture, the gate drops
    // every report, and the viewport is what is left to move.
    fake.mouseTracking = true
    fake.sgrMouse = true
    fake.scrollbackLength = 500
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    expect(pane.scroll(drag(-64))).toBe(0)
    expect(seen).toEqual([])
    expect(fake.scrolls).toEqual([-4])
    expect(fake.viewportY).toBe(4)
  })

  it('a mouse mode the policy cannot encode reads back rather than swallowing the drag', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.mouseTracking = true
    fake.scrollbackLength = 500
    pane.setInputEnabled(true)
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    expect(pane.scroll(drag(-64))).toBe(0)
    expect(seen).toEqual([])
    expect(fake.scrolls).toEqual([-4])
  })

  it('an armed mirror hands a mouse-tracking program its reports and moves no viewport', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.mouseTracking = true
    fake.sgrMouse = true
    fake.scrollbackLength = 500
    pane.setInputEnabled(true)
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    expect(pane.scroll(drag(-64))).toBe(-64)
    expect(seen).toEqual(['\x1b[<64;1;1M'])
    expect(fake.scrolls).toEqual([])
  })

  it('reads the screen it is on from the emulator mode, never from the screen text', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    expect(pane.isAlternateScreen()).toBe(false)
    fake.alternateScreen = true
    expect(pane.isAlternateScreen()).toBe(true)
  })

  it('wheel on the normal screen is left to the emulator viewport', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    pane.setInputEnabled(true)
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    expect(wheel(fake, 96)).toBe(false)
    expect(seen).toEqual([])
    expect(fake.scrolls).toEqual([])
  })

  it('wheel on the alternate screen sends page keys through the input gate and never scrolls the viewport', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    const seen: string[] = []
    pane.events.onData((data) => seen.push(data))
    expect(wheel(fake, 96)).toBe(true)
    expect(seen).toEqual([])
    pane.setInputEnabled(true)
    expect(wheel(fake, 96)).toBe(true)
    expect(wheel(fake, -96)).toBe(true)
    expect(seen).toEqual([PAGE_DOWN, PAGE_UP])
    expect(fake.scrolls).toEqual([])
  })

  it('loads the wasm through a bundle url once per document', async () => {
    await createGhosttyCompanionPane(80, 24)
    await createGhosttyCompanionPane(80, 24)
    expect(initCalls.urls).toHaveLength(1)
    expect(initCalls.urls[0]).toContain('ghostty-vt')
    expect(initCalls.urls[0]).toContain('.wasm')
  })
})
