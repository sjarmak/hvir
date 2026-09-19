// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { ghosttyState, ghosttyWebMock } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

const NOTICE = '.terminal-held-geometry-notice'
const HELD = { cols: 61, rows: 23 }
/** 780x400 at 13px cells (7.8x15.6) fits 100x25, distinct from the held grid. */
const OWN = { cols: 100, rows: 25 }

describe('GhosttyTerminalPane held geometry (ADR-052)', () => {
  beforeEach(() => {
    ghosttyState.instances.splice(0)
    ghosttyWebMock.init.mockClear()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('draws the held grid without fitting, marks it while held, and refits on release', async () => {
    const { pane, container, state } = await mountedPane()
    const theme = terminalThemeForAppearance('dark')
    const surface = container.querySelector<HTMLElement>('.terminal-engine-host')!
    expect(state.resizes).toEqual([OWN])
    expect(container.querySelector(NOTICE)).toBeNull()

    pane.setHeldGeometry(HELD)

    expect(state.resizes.at(-1)).toEqual(HELD)
    expect(container.querySelector(NOTICE)?.textContent).toContain('61×23')
    expect(surface.style.background).toBe(theme.background)
    // Fitting is suspended: a settle period brings no refit back to the pane's own size.
    await settleTerminalFit()
    expect(state.resizes).toEqual([OWN, HELD])
    expect(container.querySelectorAll(NOTICE)).toHaveLength(1)

    pane.setHeldGeometry(undefined)

    expect(container.querySelector(NOTICE)).toBeNull()
    expect(surface.style.background).toBe('')
    await settleTerminalFit()
    expect(state.resizes).toEqual([OWN, HELD, OWN])
    pane.dispose()
  })

  it('hidden wins over held, and reveal while held presents the held grid without a refit', async () => {
    const { pane, container, state } = await mountedPane()
    const canvas = container.querySelector('canvas')!
    expect(state.presentationPausedValues).toEqual([true, false])

    pane.setPresentation('hidden')
    pane.setHeldGeometry(HELD)

    expect(state.resizes.at(-1)).toEqual(HELD)
    expect(canvas.style.visibility).toBe('hidden')
    expect(state.presentationPausedValues).toEqual([true, false, true])
    expect(container.querySelector(NOTICE)).not.toBeNull()

    pane.setPresentation('visible')
    await settleTerminalFit()

    expect(canvas.style.visibility).toBe('')
    expect(state.presentationPausedValues).toEqual([true, false, true, false])
    expect(state.resizes).toEqual([OWN, HELD])

    pane.setPresentation('hidden')
    pane.setHeldGeometry(undefined)
    await settleTerminalFit()

    expect(state.resizes).toEqual([OWN, HELD])
    expect(state.presentationPausedValues).toEqual([true, false, true, false, true])
    pane.dispose()
  })

  it('a hold arriving during a pending reveal still presents the frame', async () => {
    const { pane, container, state } = await mountedPane()
    const canvas = container.querySelector('canvas')!

    pane.setPresentation('hidden')
    pane.setPresentation('visible')
    pane.setHeldGeometry(HELD)
    await settleTerminalFit()

    expect(canvas.style.visibility).toBe('')
    expect(state.presentationPausedValues.at(-1)).toBe(false)
    expect(state.resizes).toEqual([OWN, HELD])
    pane.dispose()
  })
})

async function mountedPane() {
  const container = document.createElement('div')
  document.body.append(container)
  const pane = await createGhosttyTerminalPane(
    terminalThemeForAppearance('dark'),
    { fontFamily: 'ui-monospace, monospace', fontSize: 13 },
    {
      cursorDefaults: { shape: 'block', blink: 'terminal' },
      ligatures: true,
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    },
  )
  const state = ghosttyState.instances[0]!
  pane.mount(container)
  const surface = container.querySelector<HTMLElement>('.terminal-engine-host')!
  Object.defineProperties(surface, {
    clientWidth: { configurable: true, value: 780 },
    clientHeight: { configurable: true, value: 400 },
  })
  await settleTerminalFit()
  return { pane, container, state }
}

function settleTerminalFit(delay = 100): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delay))
}
