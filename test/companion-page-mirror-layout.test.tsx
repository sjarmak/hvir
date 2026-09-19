// @vitest-environment happy-dom

/**
 * The mirror fills the phone (hvir-3k2.3): one header line, the terminal in
 * the height that remains, one control bar that shows typing controls only
 * while armed; the reflow view reads the pane as a page, a grid view is a
 * transform of the desktop's grid with touch scrolling its scrollback, and no
 * view ever sends a resize.
 */
import { act } from 'react'
import { describe, expect, it } from 'vitest'

import { COMPANION_MIRROR_ZOOM_STORAGE_KEY } from '../src/renderer/companion/src/companion-mirror-zoom'
import {
  armButton,
  button,
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

async function touchDrag(from: number, to: number): Promise<void> {
  await act(async () => {
    const element = terminalHost()
    for (const [type, clientY] of [
      ['pointerdown', from],
      ['pointermove', to],
      ['pointerup', to],
    ] as const) {
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'touch',
          clientY,
          bubbles: true,
        }),
      )
    }
    await Promise.resolve()
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
    expect(header?.querySelector('.companion-back')?.textContent).toBe('Sessions')
    expect(header?.querySelector('.companion-zoom')).not.toBeNull()
    expect(terminalHost().closest('.companion-terminal-area')).not.toBeNull()
    expect(terminalHost().dataset['zoom']).toBe('reflow')
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

  it('a touch drag over fill-height scrolls the pane by rows and sends nothing to the desktop', async () => {
    localStorage.setItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY, 'fill-height')
    await openMirror()
    const pane = panes.panes[0]!
    await touchDrag(300, 252)
    expect(pane.scrolls).toEqual([3])
    await touchDrag(100, 132)
    expect(pane.scrolls).toEqual([3, -2])
    expect(server.calls.some((call) => call.url.includes('resize'))).toBe(false)
    expect(server.inputs()).toEqual([])
  })

  it('opens in the reflow view: the pane text as a page, the grid hidden, nothing resized', async () => {
    await openMirror()
    const pane = panes.panes[0]!
    pane.lines = [
      { text: 'a long line the desktop br', wrapped: false },
      { text: 'oke in two', wrapped: true },
      { text: '$ ', wrapped: false },
    ]
    await emit('terminal', { type: 'output', handle: 'term-1', data: 'x' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 120)))
    const page = host.querySelector<HTMLElement>('.companion-terminal-reflow')
    expect(page?.hidden).toBe(false)
    expect(page?.textContent).toBe('a long line the desktop broke in two\n$')
    expect(host.querySelector<HTMLElement>('.companion-terminal-extent')?.hidden).toBe(
      true,
    )
    expect(pane.resizes).toEqual([])
    expect(server.calls.some((call) => call.url.includes('resize'))).toBe(false)
    expect(server.inputs()).toEqual([])
  })

  it('the view control cycles reflow, fit width and fill height, and persists the choice', async () => {
    await openMirror()
    layoutHost(352, 344)
    const surface = (): string =>
      host.querySelector<HTMLElement>('.companion-terminal-scale')?.style.transform ?? ''
    const extent = (): [string, string] => {
      const element = host.querySelector<HTMLElement>('.companion-terminal-extent')
      return [element?.style.width ?? '', element?.style.height ?? '']
    }
    const control = button('Reflow')
    expect(control.classList.contains('companion-zoom')).toBe(true)
    expect(control.getAttribute('aria-label')).toBe('View: Reflow. Switch to Fit width')

    await click(button('Reflow'))
    expect(terminalHost().dataset['zoom']).toBe('fit-width')
    expect(host.querySelector<HTMLElement>('.companion-terminal-reflow')?.hidden).toBe(
      true,
    )
    expect(surface()).toContain('scale(0.3333')
    expect(extent()).toEqual(['352px', '230px'])
    expect(localStorage.getItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY)).toBe('fit-width')

    await click(button('Fit width'))
    expect(terminalHost().dataset['zoom']).toBe('fill-height')
    expect(surface()).toBe('scale(0.5)')
    expect(extent()).toEqual(['528px', '344px'])
    expect(localStorage.getItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY)).toBe('fill-height')

    await click(button('Fill height'))
    expect(terminalHost().dataset['zoom']).toBe('reflow')
    expect(host.querySelector<HTMLElement>('.companion-terminal-reflow')?.hidden).toBe(
      false,
    )
    expect(localStorage.getItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY)).toBe('reflow')
    expect(panes.panes[0]?.resizes).toEqual([])
    expect(server.calls.some((call) => call.url.includes('resize'))).toBe(false)
  })

  it('a stored grid view is honored when a mirror opens', async () => {
    localStorage.setItem(COMPANION_MIRROR_ZOOM_STORAGE_KEY, 'fit-width')
    await openMirror()
    expect(terminalHost().dataset['zoom']).toBe('fit-width')
    expect(button('Fit width').classList.contains('companion-zoom')).toBe(true)
    expect(host.querySelector<HTMLElement>('.companion-terminal-reflow')?.hidden).toBe(
      true,
    )
  })
})
