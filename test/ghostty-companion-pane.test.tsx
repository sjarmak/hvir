// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPANION_DEFAULT_TEXT_SIZE } from '../src/renderer/companion/src/companion-text-size'
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
  /** Times `scrollToBottom` put the viewport back on the newest output. */
  returns: number
  /** What the next `resize` reflows the scrollback down to, so the reflow is what shortens it. */
  reflowedScrollbackLength?: number
  /** Rows each write adds to the scrollback, as output on the normal screen does. */
  growOnWrite: number
  /** The screen the next write switches to, so a transition happens inside `write`. */
  screenOnWrite?: boolean
  /** Every call that would read what the screen says; the position path must add none. */
  readonly textReads: string[]
  onResizeSubscriptions: number
  /** Listeners the pane holds on the emulator's own scroll event. */
  scrollSubscriptions: number
  /** Fires `onScroll` with the value ghostty would carry, which is not always `viewportY`. */
  fireScroll: (value: number) => void
  /**
   * Fires every handler ever registered, disposed ones included, which models
   * an emitter that does not honour its own disposer. Nothing reaches a
   * subscriber unless the pane also let go of the subscribers it holds.
   */
  fireScrollPastDisposal: (value: number) => void
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
    private readonly scrollListeners = new Set<(value: number) => void>()
    private readonly everyScrollListener = new Set<(value: number) => void>()
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
        returns: 0,
        growOnWrite: 0,
        textReads: [],
        onResizeSubscriptions: 0,
        scrollSubscriptions: 0,
        disposed: false,
        alternateScreen: false,
        mouseTracking: false,
        sgrMouse: false,
        emitData: (data) => {
          for (const listener of this.dataListeners) listener(data)
        },
        fireScroll: (value) => {
          for (const listener of this.scrollListeners) listener(value)
        },
        fireScrollPastDisposal: (value) => {
          for (const listener of this.everyScrollListener) listener(value)
        },
      }
      this.state = state
      fakes.push(state)
    }

    // The mode flags the pane is allowed to ask for, beside every cell-reading
    // call the real `wasmTerm` offers (ghostty.d.ts:146-270). That route is the
    // idiomatic one in this repo, so it is the route the negative assertion has
    // to cover: a read added here must show up in `textReads`.
    readonly wasmTerm = {
      isAlternateScreen: () => this.state.alternateScreen,
      hasMouseTracking: () => this.state.mouseTracking,
      getMode: () => this.state.sgrMouse,
      getViewport: () => this.readsText('wasmTerm.getViewport', []),
      getLine: (y: number) => this.readsText(`wasmTerm.getLine ${y}`, null),
      getBufferLine: (type: string, y: number) =>
        this.readsText(`wasmTerm.getBufferLine ${type} ${y}`, null),
      getScrollbackLine: (offset: number) =>
        this.readsText(`wasmTerm.getScrollbackLine ${offset}`, null),
      getScrollbackViewport: (start: number, rows: number) =>
        this.readsText(`wasmTerm.getScrollbackViewport ${start} ${rows}`, null),
      getScrollbackGraphemeString: (offset: number, col: number) =>
        this.readsText(`wasmTerm.getScrollbackGraphemeString ${offset} ${col}`, ''),
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

    readonly onScroll = (listener: (value: number) => void) => {
      this.scrollListeners.add(listener)
      this.everyScrollListener.add(listener)
      this.state.scrollSubscriptions += 1
      return {
        dispose: () => {
          this.scrollListeners.delete(listener)
          this.state.scrollSubscriptions -= 1
        },
      }
    }

    /** Records the call and answers it, so a text read is visible rather than absent. */
    private readsText<T>(call: string, answer: T): T {
      this.state.textReads.push(call)
      return answer
    }

    // What the pane would be reading if it asked what the screen says
    // (terminal.d.ts:22, 215-251, 376).
    get buffer(): unknown {
      return this.readsText('buffer', {})
    }

    getSelection(): string {
      return this.readsText('getSelection', '')
    }

    hasSelection(): boolean {
      return this.readsText('hasSelection', false)
    }

    getSelectionPosition(): unknown {
      return this.readsText('getSelectionPosition', undefined)
    }

    selectAll(): void {
      this.readsText('selectAll', undefined)
    }

    getScrollbackLine(offset: number): unknown {
      return this.readsText(`getScrollbackLine ${offset}`, null)
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

    // ghostty-web.js:4796-4810. A viewport held behind the live edge on the
    // normal screen keeps the rows it is showing: the write advances viewportY
    // by whatever the scrollback grew, and fires the scroll event with the new
    // number. Anything else (the live edge, the alternate screen, a screen
    // transition) puts the viewport back on the newest output.
    write(data: string): void {
      this.state.writes.push(data)
      const before = this.state.viewportY
      const wasAlternate = this.state.alternateScreen
      const lengthBefore = this.state.scrollbackLength
      const screen = this.state.screenOnWrite
      if (screen !== undefined) this.state.alternateScreen = screen
      if (!this.state.alternateScreen) {
        this.state.scrollbackLength = lengthBefore + this.state.growOnWrite
      }
      if (this.state.alternateScreen !== wasAlternate) this.resetViewport()
      if (before > 0 && !wasAlternate && !this.state.alternateScreen) {
        const grew = Math.max(0, this.state.scrollbackLength - lengthBefore)
        this.setViewport(before + grew)
      } else if (this.state.viewportY !== 0) {
        this.scrollToBottom()
      }
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
      this.setViewport(this.state.viewportY - amount)
    }

    scrollToLine(line: number): void {
      this.state.anchors.push(line)
      this.setViewport(line)
    }

    scrollToBottom(): void {
      this.state.returns += 1
      this.setViewport(0)
    }

    getViewportY(): number {
      return this.state.viewportY
    }

    getScrollbackLength(): number {
      return this.state.scrollbackLength
    }

    private resetViewport(): void {
      this.setViewport(0)
    }

    /** Every mover clamps into the scrollback and fires only on a change. */
    private setViewport(line: number): void {
      const next = Math.max(0, Math.min(this.state.scrollbackLength, line))
      if (next === this.state.viewportY) return
      this.state.viewportY = next
      this.state.fireScroll(next)
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
    gesture: 'drag',
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

  it('draws the phone text size over the same scrollback the desktop pane keeps, and reports its cell (ADR-058, ADR-059)', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    expect(fake.options['fontSize']).toBe(COMPANION_DEFAULT_TEXT_SIZE)
    expect(fake.options['scrollbackBytes']).toBe(10_000_000)
    // The cell is what the page's fit divides its area by to hold the PTY.
    pane.mount(document.createElement('div'))
    expect(pane.cellSize()).toEqual({ width: 8, height: 16 })
  })

  it('takes the size the page chose, and only ever a step of the ladder (ADR-059)', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    pane.setFontSize(8)
    expect(fake.options['fontSize']).toBe(8)
    // A size off the ladder is drawn at the step nearest it rather than as given.
    pane.setFontSize(13.6)
    expect(fake.options['fontSize']).toBe(13)
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

  it('a drag on the alternate screen pages the program and moves no viewport', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    fake.scrollbackLength = 500
    pane.setInputEnabled(true)
    const typed: string[] = []
    const paged: string[] = []
    pane.events.onData((data) => typed.push(data))
    pane.events.onNavigation((data) => paged.push(data))
    // Half the 24 rows at 16px is what one page costs a finger, so this is
    // exactly one. The program answers the gesture in its own terms and this
    // surface moved no pixel, so the whole travel is the page's to scroll a
    // too-tall grid with.
    expect(pane.scroll(drag(-192))).toBe(-192)
    expect(paged).toEqual([PAGE_UP])
    expect(typed).toEqual([])
    expect(fake.scrolls).toEqual([])
    expect(fake.viewportY).toBe(0)
  })

  it('a disarmed mirror still pages a program through its own history (ADR-055)', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    const typed: string[] = []
    const paged: string[] = []
    pane.events.onData((data) => typed.push(data))
    pane.events.onNavigation((data) => paged.push(data))
    // The arm stops an unattended phone typing; a finger on the grid is not
    // that, so reading back leaves a mirror nobody armed.
    expect(pane.scroll(drag(-192))).toBe(-192)
    expect(paged).toEqual([PAGE_UP])
    expect(typed).toEqual([])
    expect(fake.scrolls).toEqual([])
  })

  it('a disarmed mirror under a mouse-tracking program sends its wheel reports (ADR-056)', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    // A program on the normal screen that asked for mouse reports, on the
    // default disarmed mirror. The report is what its own desktop sends for the
    // same gesture, so the arm does not hold it and the viewport stays put.
    fake.mouseTracking = true
    fake.sgrMouse = true
    fake.scrollbackLength = 500
    const typed: string[] = []
    const paged: string[] = []
    pane.events.onData((data) => typed.push(data))
    pane.events.onNavigation((data) => paged.push(data))
    expect(pane.scroll(drag(-64))).toBe(-64)
    expect(paged).toEqual(['\x1b[<64;1;1M'])
    expect(typed).toEqual([])
    expect(fake.scrolls).toEqual([])
  })

  it('one move worth several reports sends them as one string, in order (ADR-056)', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.mouseTracking = true
    fake.sgrMouse = true
    const paged: string[] = []
    pane.events.onNavigation((data) => paged.push(data))
    // Three notches of travel at 3 lines of 16px each: three reports, one
    // emission. Sent one request each they would race; as one write they land
    // in the order the finger moved.
    expect(pane.scroll(drag(-144))).toBe(-144)
    expect(paged).toEqual(['\x1b[<64;1;1M'.repeat(3)])
  })

  it('the lift of the finger drops what the policy banked for a drag', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.mouseTracking = true
    fake.sgrMouse = true
    const paged: string[] = []
    pane.events.onNavigation((data) => paged.push(data))
    // Thirty notches in one move: a screen of 24 go and six are banked for the next move.
    pane.scroll(drag(-1440))
    expect(paged).toEqual(['\x1b[<64;1;1M'.repeat(24)])
    pane.endGesture()
    // A fresh touch a hair long owes nothing from the last one.
    pane.scroll(drag(-1))
    expect(paged).toEqual(['\x1b[<64;1;1M'.repeat(24)])
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
    const paged: string[] = []
    pane.events.onNavigation((data) => paged.push(data))
    expect(pane.scroll(drag(-64))).toBe(-64)
    expect(paged).toEqual(['\x1b[<64;1;1M'])
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

  it('wheel on the alternate screen pages the program armed or not, and never scrolls the viewport', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    const typed: string[] = []
    const paged: string[] = []
    pane.events.onData((data) => typed.push(data))
    pane.events.onNavigation((data) => paged.push(data))
    expect(wheel(fake, 96)).toBe(true)
    expect(paged).toEqual([PAGE_DOWN])
    pane.setInputEnabled(true)
    expect(wheel(fake, -96)).toBe(true)
    expect(paged).toEqual([PAGE_DOWN, PAGE_UP])
    expect(typed).toEqual([])
    expect(fake.scrolls).toEqual([])
  })

  it('a mouse mode the policy cannot encode still reads back rather than going dead', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    // Tracking without SGR: the policy has no report it will synthesize, so it
    // consumes the gesture and the viewport is what is left to move. This is the
    // shape ADR-056 refuses to reach by carrying half the mouse family.
    fake.mouseTracking = true
    fake.sgrMouse = false
    fake.scrollbackLength = 500
    const typed: string[] = []
    const paged: string[] = []
    pane.events.onData((data) => typed.push(data))
    pane.events.onNavigation((data) => paged.push(data))
    expect(pane.scroll(drag(-64))).toBe(0)
    expect(typed).toEqual([])
    expect(paged).toEqual([])
    expect(fake.scrolls).toEqual([-4])
  })

  it('a drag pays half the screen for a page and a wheel notch still pays three lines', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.alternateScreen = true
    const paged: string[] = []
    pane.events.onNavigation((data) => paged.push(data))

    // Half of 24 rows at 16px: a page short of that sends nothing and banks it.
    pane.scroll(drag(-176))
    expect(paged).toEqual([])
    pane.scroll(drag(-16))
    expect(paged).toEqual([PAGE_UP])

    // The same distance as a notch is worth four pages, because a notch is
    // three lines of intent rather than a distance across the screen. One goes
    // now and the rest is banked, which is the rate limit and not a loss.
    wheel(fake, -192)
    expect(paged).toEqual([PAGE_UP, PAGE_UP])
    wheel(fake, -1)
    expect(paged).toEqual([PAGE_UP, PAGE_UP, PAGE_UP])
  })

  it('a viewport subscriber is told where the viewport is, not what the event carries', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    fake.scrollbackLength = 500
    // ghostty floors the number its event carries during a smooth scroll
    // (ghostty-web.js:5126), so a viewport four tenths of a row off the live
    // edge would arrive as zero and read as live.
    fake.viewportY = 0.4
    fake.fireScroll(0)
    expect(offsets).toEqual([0.4])
  })

  it('returning to live puts the viewport on the newest output and says so once', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    fake.scrollbackLength = 500
    fake.viewportY = 40
    pane.returnToLive()
    expect(fake.returns).toBe(1)
    expect(fake.viewportY).toBe(0)
    expect(offsets).toEqual([0])
    // Already live: ghostty fires nothing and neither does the pane.
    pane.returnToLive()
    expect(offsets).toEqual([0])
  })

  it('the way back ends the drag that preceded it rather than carrying its fraction', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    fake.scrollbackLength = 500
    // Nine tenths of a row of finger: too little to move a row, kept for the
    // rest of the gesture.
    pane.scroll(drag(-14.4))
    expect(fake.scrolls).toEqual([])
    pane.returnToLive()
    expect(fake.viewportY).toBe(0)

    // A fifth of a row afterwards is its own gesture and moves no row. Kept,
    // the earlier nine tenths would carry it past a whole one.
    pane.scroll(drag(-3.2))
    expect(fake.scrolls).toEqual([])
    expect(fake.viewportY).toBe(0)
  })

  it('the pane stops listening to the emulator when it is disposed', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    expect(fake.scrollSubscriptions).toBe(1)
    pane.dispose()
    expect(fake.scrollSubscriptions).toBe(0)
    fake.fireScroll(9)
    expect(offsets).toEqual([])
  })

  it('a disposed pane notifies nobody even from a handler it could not unregister', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    fake.scrollbackLength = 500
    fake.viewportY = 40
    pane.dispose()
    // The second guarantee, independent of the emulator's own disposer: the
    // pane lets go of the subscribers it holds, so a page that kept one is
    // told nothing by a pane that is gone.
    fake.fireScrollPastDisposal(40)
    expect(offsets).toEqual([])
  })

  it('output arriving while the viewport is read back keeps the rows it is showing', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    fake.scrollbackLength = 100
    fake.viewportY = 20
    // The row the person is reading, counted from the oldest row the emulator
    // still holds, which is what must not move under them.
    const reading = fake.scrollbackLength - fake.viewportY
    fake.growOnWrite = 5
    pane.write('a line of output')
    pane.write('and another')
    expect(fake.scrollbackLength - fake.viewportY).toBe(reading)
    expect(fake.viewportY).toBe(30)
    expect(fake.returns).toBe(0)
    // Off the live edge throughout, so the way back never blinks away.
    expect(offsets).toEqual([25, 30])
  })

  it('output arriving at the live edge leaves the viewport there', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    fake.growOnWrite = 5
    pane.write('a line of output')
    expect(fake.viewportY).toBe(0)
    expect(offsets).toEqual([])
  })

  it('a program taking the whole screen leaves no viewport off the live edge', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    const offsets: number[] = []
    pane.events.onViewport((offset) => offsets.push(offset))
    fake.scrollbackLength = 100
    fake.viewportY = 20
    // The write that switches to the alternate screen resets the viewport
    // (ghostty-web.js:4801), and the alternate screen keeps no scrollback.
    fake.screenOnWrite = true
    pane.write('[?1049h')
    expect(fake.viewportY).toBe(0)
    expect(offsets).toEqual([0])
    pane.write('full screen paint')
    expect(fake.viewportY).toBe(0)
    expect(offsets).toEqual([0])
  })

  it('the whole viewport path asks where the view is and never what it says', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    pane.events.onViewport(() => undefined)
    fake.scrollbackLength = 200
    fake.viewportY = 30
    fake.growOnWrite = 2
    pane.write('output while read back')
    pane.scroll(drag(-64))
    fake.fireScroll(12)
    pane.returnToLive()
    pane.resize(90, 30)
    expect(fake.textReads).toEqual([])
  })

  it('loads the wasm through a bundle url once per document', async () => {
    await createGhosttyCompanionPane(80, 24)
    await createGhosttyCompanionPane(80, 24)
    expect(initCalls.urls).toHaveLength(1)
    expect(initCalls.urls[0]).toContain('ghostty-vt')
    expect(initCalls.urls[0]).toContain('.wasm')
  })
})
