// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyCompanionPane } from '../src/renderer/companion/src/ghostty-companion-pane'

interface FakeTerminalState {
  readonly options: Record<string, unknown>
  readonly writes: string[]
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>
  onResizeSubscriptions: number
  opened?: HTMLElement
  disposed: boolean
  /** Fires the terminal's own reply synchronously inside the next write. */
  replyOnWrite?: string
  emitData: (data: string) => void
}

const fakes: FakeTerminalState[] = []
const initCalls = vi.hoisted(() => ({ urls: [] as string[] }))

vi.mock('ghostty-web', () => {
  class Terminal {
    readonly options: Record<string, unknown>
    private readonly dataListeners = new Set<(data: string) => void>()
    private readonly state: FakeTerminalState
    element?: HTMLElement

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      const state: FakeTerminalState = {
        options: this.options,
        writes: [],
        resizes: [],
        onResizeSubscriptions: 0,
        disposed: false,
        emitData: (data) => {
          for (const listener of this.dataListeners) listener(data)
        },
      }
      this.state = state
      fakes.push(state)
    }

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

    write(data: string): void {
      this.state.writes.push(data)
      const reply = this.state.replyOnWrite
      if (reply !== undefined) this.state.emitData(reply)
    }

    resize(cols: number, rows: number): void {
      this.state.resizes.push({ cols, rows })
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

beforeEach(() => {
  fakes.splice(0)
})

afterEach(() => {
  document.body.replaceChildren()
})

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

  it('data emitted during write never reaches onData', async () => {
    const pane = await createGhosttyCompanionPane(80, 24)
    const fake = fakes[0]!
    pane.mount(document.createElement('div'))
    pane.setInputEnabled(true)
    const seen: string[] = []
    pane.events.onData((data, source) => seen.push(`${source}:${data}`))
    fake.replyOnWrite = '\u001b[?1;2c'
    pane.write('\u001b[c')
    expect(fake.writes).toEqual(['\u001b[c'])
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

  it('loads the wasm through a bundle url once per document', async () => {
    await createGhosttyCompanionPane(80, 24)
    await createGhosttyCompanionPane(80, 24)
    expect(initCalls.urls).toHaveLength(1)
    expect(initCalls.urls[0]).toContain('ghostty-vt')
    expect(initCalls.urls[0]).toContain('.wasm')
  })
})
