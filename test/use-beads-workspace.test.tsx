// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useBeadsWorkspace,
  type BeadsWorkspace,
} from '../src/renderer/src/beads/use-beads-workspace'
import { asHostId, hostPath } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/home/dev/city/rigs/mem')

let host: HTMLDivElement
let root: Root
let latest: BeadsWorkspace | undefined

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
  latest = useBeadsWorkspace(
    {
      root: ROOT,
      connectionState: 'connected',
      ...(workspaceId === undefined ? {} : { activeWorkspace: { id: workspaceId } }),
    },
    { railMode: 'beads', setRailMode: vi.fn() },
  )
  return createElement('div')
}

async function render(workspaceId?: string): Promise<BeadsWorkspace> {
  await act(async () => {
    root.render(createElement(Probe, { workspaceId }))
    await Promise.resolve()
  })
  if (!latest) throw new Error('hook did not render')
  return latest
}

async function within(run: () => void): Promise<BeadsWorkspace> {
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
    const next = await within(() =>
      beads.requestBeadAction({ action: 'claim', id: 'hv-12' }),
    )
    expect(next.attachRequestFor('ws-1')).toEqual({
      command: "bd update 'hv-12' --claim",
      nonce: 1,
    })
    expect(next.attachRequestFor('ws-2')).toBeUndefined()
  })

  it('bumps the nonce on every request so identical commands re-fire', async () => {
    const beads = await render('ws-1')
    const first = await within(() =>
      beads.requestBeadAction({ action: 'close', id: 'hv-1' }),
    )
    const second = await within(() =>
      first.requestBeadAction({ action: 'close', id: 'hv-1' }),
    )
    const a = first.attachRequestFor('ws-1')?.nonce ?? 0
    const b = second.attachRequestFor('ws-1')?.nonce ?? 0
    expect(b).toBeGreaterThan(a)
  })

  it('still keys crew attach requests after sharing the request builder', async () => {
    const beads = await render('ws-1')
    const next = await within(() => beads.requestCrewAction('attach', 'mayor'))
    expect(next.attachRequestFor('ws-1')).toMatchObject({
      command: "gc session attach 'mayor'",
      key: 'gc:mayor',
    })
  })

  it('is a no-op without an active workspace', async () => {
    const beads = await render()
    const next = await within(() =>
      beads.requestBeadAction({ action: 'create', title: 'x' }),
    )
    expect(next.attachRequestFor('ws-1')).toBeUndefined()
  })
})
