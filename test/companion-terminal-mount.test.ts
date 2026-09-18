// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { CompanionTerminalMount } from '../src/renderer/companion/src/companion-terminal-mount'
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
} {
  const host = document.createElement('div')
  document.body.append(host)
  const failures: unknown[] = []
  const inputs: string[] = []
  const mount = new CompanionTerminalMount(
    host,
    create,
    (data) => inputs.push(data),
    (error) => failures.push(error),
  )
  return { mount, host, failures, inputs }
}

describe('CompanionTerminalMount', () => {
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
    expect(panes[0]?.mounted).toBe(host.querySelector('.companion-terminal-scale'))
    mount.handle({ type: 'output', handle: ROW, data: 'live' })
    expect(panes[0]?.writes).toEqual(['tail', 'queued', 'live'])
    mount.dispose()
    expect(panes[0]?.disposed).toBe(true)
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

  it('zoom scales the desktop grid as a transform and sizes the extent, never the pane', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount, host } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    Object.defineProperty(host, 'clientWidth', { get: () => 400 })
    Object.defineProperty(host, 'clientHeight', { get: () => 320 })
    const surface = host.querySelector<HTMLElement>('.companion-terminal-scale')
    const extent = host.querySelector<HTMLElement>('.companion-terminal-extent')

    mount.setZoom('fill-height')
    expect(surface?.style.transform).toBe('scale(0.5)')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '320px'])

    mount.setZoom('fit-width')
    expect(surface?.style.transform).toBe('scale(0.5)')
    mount.handle({ type: 'geometry', handle: ROW, cols: 200, rows: 40 })
    expect(surface?.style.transform).toBe('scale(0.25)')
    expect([extent?.style.width, extent?.style.height]).toEqual(['400px', '160px'])
    expect(panes[0]?.resizes).toEqual([{ cols: 200, rows: 40 }])
    expect(host.style.height).toBe('')
    mount.dispose()
  })

  it('a touch drag over the host scrolls the pane by rows of the scaled grid', async () => {
    const panes: FakeCompanionPane[] = []
    const { mount, host } = mountWith((cols, rows) => {
      const pane = new FakeCompanionPane(cols, rows)
      panes.push(pane)
      return Promise.resolve(pane)
    })
    mount.handle({ type: 'opened', handle: ROW, cols: 100, rows: 40, tail: '' })
    await microtasks()
    Object.defineProperty(host, 'clientWidth', { get: () => 400 })
    Object.defineProperty(host, 'clientHeight', { get: () => 1000 })
    mount.setZoom('fit-width')
    const drag = (type: string, clientY: number): boolean =>
      host.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientY, bubbles: true }),
      )
    drag('pointerdown', 100)
    drag('pointermove', 76)
    drag('pointerup', 76)
    expect(panes[0]?.scrolls).toEqual([3])
    mount.dispose()
    drag('pointerdown', 100)
    drag('pointermove', 76)
    expect(panes[0]?.scrolls).toEqual([3])
  })
})
