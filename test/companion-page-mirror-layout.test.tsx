// @vitest-environment happy-dom

/**
 * The mirror fills the phone (hvir-3k2.3): one header line, the terminal in
 * the height that remains, one control bar that shows typing controls only
 * while armed; the terminal is the desktop's grid scaled to the phone's width
 * and nothing ever sends a resize (ADR-050). The emulator's own viewport is the whole read-back
 * (ADR-053), so the area holds the grid and the page's stated states beside
 * it, never a second surface of text.
 */
import { act } from 'react'
import { describe, expect, it } from 'vitest'

import {
  armButton,
  click,
  emit,
  host,
  openMirror,
  panes,
  server,
  settle,
  useCompanionPage,
} from './companion-page-harness'

/** What the shared wheel policy sends an alternate-screen program (ADR-053). */
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'

useCompanionPage()

function terminalHost(): HTMLElement {
  const element = host.querySelector<HTMLElement>('.companion-terminal-host')
  if (element === null) throw new Error('missing terminal host')
  return element
}

/** happy-dom lays nothing out: the area's size is stated for the fit. */
function layoutHost(width: number, height: number): void {
  const element = terminalHost()
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => height,
  })
}

describe('Companion page mirror layout', () => {
  it('lays the mirror out as one header, the terminal area, then a control bar with nothing after it', async () => {
    await openMirror()
    const section = host.querySelector('.companion-terminal')
    const children = [...(section?.children ?? [])].map((child) => child.className)
    expect(children).toEqual([
      'companion-mirror-header',
      'companion-terminal-area',
      'companion-mirror-controls',
    ])
    const header = section?.querySelector('.companion-mirror-header')
    expect(header?.querySelector('.companion-mirror-title')?.textContent).toBe(
      'claude in shell',
    )
    expect(
      [...(header?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
    ).toEqual(['Sessions'])
    expect(terminalHost().closest('.companion-terminal-area')).not.toBeNull()
    const controls = section?.querySelector('.companion-mirror-controls')
    expect(
      [...(controls?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
    ).toEqual(['Arm typing'])
    expect(controls?.querySelectorAll('input, form')).toHaveLength(0)
  })

  it('the control bar shows the key strip and the text field only while armed', async () => {
    await openMirror()
    expect(host.querySelector('.companion-keys')).toBeNull()
    expect(host.querySelector('.companion-terminal-form')).toBeNull()
    await click(armButton())
    const controls = host.querySelector('.companion-mirror-controls')
    expect(controls?.querySelector('.companion-keys')).not.toBeNull()
    expect(controls?.querySelector('#companion-terminal-text')).not.toBeNull()
    expect(controls?.children).toHaveLength(2)
    await click(armButton())
    expect(host.querySelector('.companion-keys')).toBeNull()
    expect(host.querySelector('.companion-terminal-form')).toBeNull()
    expect(host.querySelector('.companion-mirror-controls')?.children).toHaveLength(1)
  })

  it('scales the desktop grid to the area width and never resizes', async () => {
    await openMirror()
    layoutHost(352, 344)
    const pane = panes.panes[0]!
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'x' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)))
    expect(host.querySelector('.companion-terminal-history')).toBeNull()
    expect(
      host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform,
    ).toContain('scale(0.3333')
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')
    expect(extent?.style.width).toBe('352px')
    expect(pane.resizes).toEqual([])
    expect(server.calls.some((call) => call.url.includes('resize'))).toBe(false)
    expect(server.inputs()).toEqual([])
  })

  it('says a full-screen program keeps its own history, outside the box that clips the grid', async () => {
    await openMirror()
    layoutHost(352, 344)
    expect(host.querySelector('.companion-mirror-own-history')).toBeNull()

    panes.panes[0]!.alternateScreen = true
    await emit('terminal', {
      type: 'output',
      handle: 'term-1',
      data: 'full screen paint',
    })
    const notice = host.querySelector<HTMLElement>('.companion-mirror-own-history')
    // Never that the session has none: tmux and a pager hold a full history
    // the emulator has no scrollback for (ADR-055).
    expect(notice?.textContent).toBe(
      'This program keeps its own history. Drag to page back through it.',
    )
    expect(notice?.getAttribute('role')).toBe('status')
    expect(notice?.closest('.companion-terminal-area')).not.toBeNull()
    expect(notice?.closest('.companion-terminal-extent')).toBeNull()

    panes.panes[0]!.alternateScreen = false
    await emit('terminal', { type: 'output', handle: 'term-1', data: '$ ' })
    expect(host.querySelector('.companion-mirror-own-history')).toBeNull()
  })

  it('pages a program through its own history from a disarmed mirror (ADR-055)', async () => {
    await openMirror()
    layoutHost(352, 344)
    panes.panes[0]!.alternateScreen = true
    await emit('terminal', {
      type: 'output',
      handle: 'term-1',
      data: 'full screen paint',
    })
    expect(armButton().textContent).toBe('Arm typing')

    await act(async () => {
      panes.panes[0]!.emitNavigation(PAGE_UP)
      await Promise.resolve()
    })
    await settle()
    expect(server.inputs()).toEqual([{ page: 'page-1', data: PAGE_UP, navigation: true }])
    // Reading back is not typing, so it arms nothing and shows no banner.
    expect(armButton().textContent).toBe('Arm typing')
    expect(host.querySelector('.companion-error')).toBeNull()
  })

  it('reports made while one is in flight join the next request, in order', async () => {
    await openMirror()
    layoutHost(352, 344)
    panes.panes[0]!.alternateScreen = true
    await emit('terminal', {
      type: 'output',
      handle: 'term-1',
      data: 'full screen paint',
    })

    // Three moves before the first answer lands: one request out, the other
    // two waiting as one, so the desktop writes them in the order made.
    await act(async () => {
      panes.panes[0]!.emitNavigation(PAGE_UP)
      panes.panes[0]!.emitNavigation(PAGE_UP)
      panes.panes[0]!.emitNavigation(PAGE_DOWN)
      await Promise.resolve()
    })
    await settle()
    expect(server.inputs()).toEqual([
      { page: 'page-1', data: PAGE_UP, navigation: true },
      { page: 'page-1', data: PAGE_UP + PAGE_DOWN, navigation: true },
    ])
  })

  it('says why when the desktop does not allow input from a phone', async () => {
    await openMirror()
    layoutHost(352, 344)
    panes.panes[0]!.alternateScreen = true
    await emit('terminal', {
      type: 'output',
      handle: 'term-1',
      data: 'full screen paint',
    })
    server.inputStatus = 403
    server.inputError = 'Typing from the Companion is off'

    await act(async () => {
      panes.panes[0]!.emitNavigation(PAGE_UP)
      await Promise.resolve()
    })
    await settle()
    expect(host.textContent).toContain(
      'Input from the Companion is off in Settings, so this program cannot be paged',
    )

    // The setting is the desktop's to change, so the next drag asks again
    // rather than leaving the page stuck on a refusal it cached.
    server.inputStatus = 200
    await act(async () => {
      panes.panes[0]!.emitNavigation(PAGE_DOWN)
      await Promise.resolve()
    })
    await settle()
    expect(host.textContent).not.toContain('so this program cannot be paged')
    expect(server.inputs()).toHaveLength(2)
  })

  it('offers no way back while the mirror is showing the newest output', async () => {
    await openMirror()
    layoutHost(352, 344)
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'x' })
    expect(host.querySelector('.companion-return-live')).toBeNull()
  })

  it('a viewport read back says the session moved on and returns to live in one tap', async () => {
    await openMirror()
    layoutHost(352, 344)
    await act(async () => {
      panes.panes[0]!.moveViewport(24)
      await Promise.resolve()
    })
    const control = host.querySelector<HTMLButtonElement>('.companion-return-live')
    expect(control?.textContent).toBe('The session has moved on. Back to live.')
    expect(control?.tagName).toBe('BUTTON')

    // Outside the host's own scroller: an absolutely positioned descendant of
    // a scroll container travels with its content, so over a grid taller than
    // the phone the one way back would scroll out of reach.
    expect(control?.closest('.companion-terminal-area')).not.toBeNull()
    expect(control?.closest('.companion-terminal-host')).toBeNull()
    expect(control?.closest('.companion-terminal-extent')).toBeNull()

    await click(control!)
    expect(panes.panes[0]?.returns).toBe(1)
    expect(host.querySelector('.companion-return-live')).toBeNull()
    expect(server.inputs()).toEqual([])
  })

  it('a full-screen program offers no way back, since there is nothing to be behind', async () => {
    await openMirror()
    layoutHost(352, 344)
    panes.panes[0]!.alternateScreen = true
    await act(async () => {
      // A viewport the emulator has not yet re-anchored, which is the only way
      // the two states meet: ADR-053 forbids an affordance that moves nothing,
      // so the page states that rather than leaving it to the emulator.
      panes.panes[0]!.moveViewport(24)
      await Promise.resolve()
    })
    await emit('terminal', {
      type: 'output',
      handle: 'term-1',
      data: 'full screen paint',
    })
    expect(host.querySelector('.companion-mirror-own-history')).not.toBeNull()
    expect(host.querySelector('.companion-return-live')).toBeNull()

    // Back on the normal screen the same held viewport does offer it.
    panes.panes[0]!.alternateScreen = false
    await emit('terminal', { type: 'output', handle: 'term-1', data: '$ ' })
    expect(host.querySelector('.companion-return-live')).not.toBeNull()
  })

  it('a full-screen session that ends takes its own-history line with it', async () => {
    await openMirror()
    layoutHost(352, 344)
    panes.panes[0]!.alternateScreen = true
    await emit('terminal', {
      type: 'output',
      handle: 'term-1',
      data: 'full screen paint',
    })
    expect(host.querySelector('.companion-mirror-own-history')).not.toBeNull()

    await emit('terminal', { type: 'ended', handle: 'term-1', reason: 'exited' })
    expect(host.querySelector('.companion-mirror-ended')).not.toBeNull()
    expect(host.querySelector('.companion-mirror-own-history')).toBeNull()
  })
})
