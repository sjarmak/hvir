// @vitest-environment happy-dom

/**
 * The mirror fills the phone (hvir-3k2.3): one header line, the terminal in
 * the height that remains, one control bar that shows typing controls only
 * while armed; the terminal is the desktop's grid scaled to the phone's width
 * with its scrollback drawn above it, and nothing sends a resize while the
 * desktop is focused. While the desktop is Away the page asks for its own grid
 * and renders it unscaled once the PTY takes it (ADR-052).
 */
import { act } from 'react'
import { describe, expect, it } from 'vitest'

import { FIT_SETTLE_MS } from '../src/renderer/companion/src/companion-terminal-fit'
import { snapshot } from './companion-page-fixture'
import {
  MIRROR_ROW,
  armButton,
  click,
  emit,
  host,
  openMirror,
  panes,
  server,
  useCompanionPage,
} from './companion-page-harness'

useCompanionPage()

/** Lets the fit settle after the area was laid out. */
async function settleFit(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, FIT_SETTLE_MS + 25)))
}

function surfaceTransform(): string | undefined {
  return host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform
}

const SCALED_TO_376 = `scale(${376 / (132 * 8)})`

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

  it('scales the desktop grid to the area width, draws the scrollback above it, and never resizes', async () => {
    await openMirror()
    layoutHost(352, 344)
    const pane = panes.panes[0]!
    pane.lines = [
      { text: 'a line the desktop br', wrapped: false },
      { text: 'oke in two', wrapped: true },
      ...Array.from({ length: 43 }, (_, i) => ({ text: `screen ${i}`, wrapped: false })),
    ]
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'x' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)))
    const history = host.querySelector<HTMLElement>('.companion-terminal-history')
    expect(history?.textContent).toBe('a line the desktop br\noke in two')
    expect(
      host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform,
    ).toContain('scale(0.3333')
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')
    expect(extent?.style.width).toBe('352px')
    expect(pane.resizes).toEqual([])
    expect(server.calls.some((call) => call.url.includes('resize'))).toBe(false)
    expect(server.inputs()).toEqual([])
  })
})

describe('Companion page mirror while the desktop is Away (ADR-052)', () => {
  it('asks once for the measured grid and renders unscaled when the matching geometry lands', async () => {
    await openMirror('$ ', true)
    layoutHost(376, 496)
    // Output refits the column to the stated layout, as the observer would in a browser.
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'x' })
    expect(server.resizes()).toEqual([])
    await settleFit()
    expect(server.resizes()).toEqual([{ page: 'page-1', cols: 47, rows: 31 }])
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/sessions/term-1/resize',
      method: 'POST',
    })
    expect(surfaceTransform()).toBe(SCALED_TO_376)

    await emit('terminal', { type: 'geometry', handle: 'term-1', cols: 47, rows: 31 })
    expect(panes.panes[0]?.resizes).toEqual([{ cols: 47, rows: 31 }])
    expect(surfaceTransform()).toBe('scale(1)')
    expect(
      host.querySelector<HTMLElement>('.companion-terminal-extent')?.style.width,
    ).toBe('376px')
    expect(host.querySelector('.companion-mirror-size')).toBeNull()
    expect(host.querySelector('.companion-error')).toBeNull()

    // The desktop reclaimed: the scaled column returns and nothing is asked again.
    await emit('terminal', { type: 'geometry', handle: 'term-1', cols: 132, rows: 43 })
    expect(surfaceTransform()).toBe(SCALED_TO_376)
    await settleFit()
    expect(server.resizes()).toHaveLength(1)
    expect(server.inputs()).toEqual([])
  })

  it('a desktop-focused refusal shows one status line and keeps the scaled view', async () => {
    server.resizeStatus = 409
    server.resizeReply = { outcome: 'refused', reason: 'desktop-focused' }
    await openMirror('$ ', true)
    layoutHost(376, 496)
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'x' })
    await settleFit()
    expect(server.resizes()).toEqual([{ page: 'page-1', cols: 47, rows: 31 }])
    const status = host.querySelector<HTMLElement>('.companion-mirror-size')
    expect(status?.textContent).toBe(
      'The desktop is focused, so it keeps the terminal size.',
    )
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.closest('.companion-terminal-area')).not.toBeNull()
    expect(host.querySelector('.companion-error')).toBeNull()
    expect(surfaceTransform()).toBe(SCALED_TO_376)
    expect(panes.panes[0]?.resizes).toEqual([])
  })

  it('asks nothing while the desktop is focused, once when the snapshot says Away, and nothing after ended', async () => {
    await openMirror()
    layoutHost(376, 496)
    await settleFit()
    expect(server.resizes()).toEqual([])

    await emit('snapshot', snapshot(2, [MIRROR_ROW], { away: true }))
    await settleFit()
    expect(server.resizes()).toEqual([{ page: 'page-1', cols: 47, rows: 31 }])

    await emit('terminal', { type: 'ended', handle: 'term-1', reason: 'exited' })
    await emit('snapshot', snapshot(3, [MIRROR_ROW], { away: false }))
    await emit('snapshot', snapshot(4, [MIRROR_ROW], { away: true }))
    await settleFit()
    expect(server.resizes()).toHaveLength(1)
  })
})
