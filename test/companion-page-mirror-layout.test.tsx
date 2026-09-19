// @vitest-environment happy-dom

/**
 * The mirror fills the phone (hvir-3k2.3): one header line, the terminal in
 * the height that remains, one control bar that shows typing controls only
 * while armed; the terminal is the desktop's grid scaled to the phone's width
 * with its scrollback drawn above it, and nothing ever sends a resize.
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
  useCompanionPage,
} from './companion-page-harness'

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
