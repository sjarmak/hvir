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
    expect(panes[0]?.mounted?.closest('div')).toBe(host.firstElementChild)
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
})
