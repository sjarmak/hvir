// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyCompanionPane } from '../src/renderer/companion/src/ghostty-companion-pane'

interface FakeTerminalState {
  readonly options: Record<string, unknown>
  readonly writes: string[]
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>
  readonly scrolls: number[]
  onResizeSubscriptions: number
  opened?: HTMLElement
  disposed: boolean
  alternateScreen: boolean
  mouseTracking: boolean
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
        onResizeSubscriptions: 0,
        disposed: false,
        alternateScreen: false,
        mouseTracking: false,
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
      getMode: () => false,
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

    resize(cols: number, rows: number): void {
      this.state.resizes.push({ cols, rows })
    }

    scrollLines(amount: number): void {
      this.state.scrolls.push(amount)
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
    expect(pane.font()).toEqual({ family: fake.options['fontFamily'], size: 15 })
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
