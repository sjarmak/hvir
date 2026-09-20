// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useBeadsWorkspace,
  type BeadsWorkspace,
} from '../src/renderer/src/beads/use-beads-workspace'
import {
  useTerminalCommands,
  type TerminalCommands,
} from '../src/renderer/src/terminal/use-terminal-commands'
import { asHostId, asSessionsExternalAttachTicket, hostPath } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/home/dev/city/rigs/mem')

let host: HTMLDivElement
let root: Root
type State = BeadsWorkspace & TerminalCommands
let latest: State | undefined

beforeEach(() => {
  ;(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  latest = undefined
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.hvir = {
    invoke: vi.fn(() => Promise.resolve({ hasProject: true })),
    on: () => () => undefined,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function Probe({ workspaceId }: { readonly workspaceId?: string }): ReactElement {
  const terminal = useTerminalCommands(workspaceId)
  const beads = useBeadsWorkspace(
    {
      root: ROOT,
      connectionState: 'connected',
    },
    { railMode: 'beads', setRailMode: vi.fn() },
    terminal,
  )
  latest = { ...terminal, ...beads }
  return createElement('div')
}

async function render(workspaceId?: string): Promise<State> {
  await act(async () => {
    root.render(createElement(Probe, { workspaceId }))
    await Promise.resolve()
  })
  if (!latest) throw new Error('hook did not render')
  return latest
}

async function within(run: () => void): Promise<State> {
  await act(async () => {
    run()
    await Promise.resolve()
  })
  if (!latest) throw new Error('hook did not render')
  return latest
}

describe('useBeadsWorkspace bead actions', () => {
  it('targets the active workspace terminal with an unkeyed bd command', async () => {
    const beads = await render('ws-1')
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    const next = await within(() => {
      void ready.requestBeadAction({ action: 'claim', id: 'hv-12' })
    })
    expect(next.attachRequestFor('ws-1')).toMatchObject({
      command: "bd update 'hv-12' --claim",
      nonce: 1,
    })
    expect(next.attachRequestFor('ws-1')?.key).toBeUndefined()
    expect(next.attachRequestFor('ws-2')).toBeUndefined()
  })

  it('bumps the nonce on every request so identical commands re-fire', async () => {
    const beads = await render('ws-1')
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    const first = await within(() => {
      void ready.requestBeadAction({ action: 'close', id: 'hv-1' })
    })
    const second = await within(() => {
      void first.requestBeadAction({ action: 'close', id: 'hv-1' })
    })
    const a = first.attachRequestFor('ws-1')?.nonce ?? 0
    const b = second.attachRequestFor('ws-1')?.nonce ?? 0
    expect(b).toBeGreaterThan(a)
  })

  it('still keys crew attach requests after sharing the request builder', async () => {
    const beads = await render('ws-1')
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    const next = await within(() => ready.requestCrewAction('attach', 'mayor'))
    expect(next.attachRequestFor('ws-1')).toMatchObject({
      command: "gc session attach 'mayor'",
      key: 'gc:mayor',
    })
  })

  it('carries the gas city session an attach names into the terminal request', async () => {
    const beads = await render('ws-1')
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    const next = await within(() =>
      ready.requestCrewAction('attach', 'mayor', 'gc-mayor-01'),
    )
    expect(next.attachRequestFor('ws-1')).toMatchObject({
      command: "gc session attach 'mayor'",
      key: 'gc:mayor',
      attaches: { sourceId: 'gas-city', key: 'gc-mayor-01' },
    })
  })

  it('is a no-op without an active workspace', async () => {
    const beads = await render()
    let accepted: boolean | undefined
    const next = await within(() => {
      void beads.requestBeadAction({ action: 'create', title: 'x' }).then((value) => {
        accepted = value
      })
    })
    expect(next.attachRequestFor('ws-1')).toBeUndefined()
    await act(async () => {
      await Promise.resolve()
    })
    expect(accepted).toBe(false)
  })
})

describe('useBeadsWorkspace launch availability', () => {
  it('reports actions unavailable until the workspace terminal says it can launch', async () => {
    const beads = await render('ws-1')
    expect(beads.actionsAvailable).toBe(false)
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    expect(ready.actionsAvailable).toBe(true)
    const other = await within(() => ready.reportLaunchAvailability('ws-2', false))
    expect(other.actionsAvailable).toBe(true)
    const gone = await within(() => other.reportLaunchAvailability('ws-1', false))
    expect(gone.actionsAvailable).toBe(false)
  })

  it('rejects a bead action without dispatching when no terminal can launch', async () => {
    const beads = await render('ws-1')
    let accepted: boolean | undefined
    const next = await within(() => {
      void beads.requestBeadAction({ action: 'claim', id: 'hv-12' }).then((value) => {
        accepted = value
      })
    })
    expect(next.attachRequestFor('ws-1')).toBeUndefined()
    await act(async () => {
      await Promise.resolve()
    })
    expect(accepted).toBe(false)
  })

  it('resolves a bead action with the outcome the terminal reports', async () => {
    const beads = await render('ws-1')
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    let accepted: boolean | undefined
    const next = await within(() => {
      void ready.requestBeadAction({ action: 'claim', id: 'hv-12' }).then((value) => {
        accepted = value
      })
    })
    const request = next.attachRequestFor('ws-1')
    expect(request?.command).toBe("bd update 'hv-12' --claim")
    expect(request?.onSettled).toBeTypeOf('function')
    await act(async () => {
      request?.onSettled?.(false)
      await Promise.resolve()
    })
    expect(accepted).toBe(false)
  })

  it('rejects a refused command without dispatching', async () => {
    const beads = await render('ws-1')
    const ready = await within(() => beads.reportLaunchAvailability('ws-1', true))
    let accepted: boolean | undefined
    const next = await within(() => {
      void ready.requestBeadAction({ action: 'claim', id: 'hv\u00031' }).then((value) => {
        accepted = value
      })
    })
    expect(next.attachRequestFor('ws-1')).toBeUndefined()
    await act(async () => {
      await Promise.resolve()
    })
    expect(accepted).toBe(false)
  })
})

it('routes external Sessions attaches before the destination reports launch availability', async () => {
  const state = await render('ws-1')
  const ticket = asSessionsExternalAttachTicket('a'.repeat(32))
  let accepted: boolean | undefined
  const pending = await within(() => {
    void state
      .requestExternalAttach('ws-2', {
        command: 'gc session attach mayor',
        key: 'gc:mayor',
        ticket,
      })
      .then((value) => {
        accepted = value
      })
  })
  expect(pending.attachRequestFor('ws-1')).toBeUndefined()
  const request = pending.attachRequestFor('ws-2')
  expect(request).toMatchObject({ key: 'gc:mayor', attaches: { ticket } })
  await within(() => request?.onSettled?.(true))
  expect(accepted).toBe(true)
})
