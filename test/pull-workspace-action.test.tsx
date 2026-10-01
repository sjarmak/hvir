// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PullWorkspaceAction } from '../src/renderer/src/github/PullWorkspaceAction'
import { asHostId, hostPath, type PullSummary, type WorkspaceState } from '../src/shared'
import type { PullCheckoutsResponse } from '../src/shared/github'

const ROOT = hostPath(asHostId('local'), '/repo')
const TARGET = hostPath(ROOT.hostId, '/feature')
const PULL = { number: 7, headRef: 'feature', headRepo: 'acme/repo' } as PullSummary
const WORKSPACE: WorkspaceState = {
  id: 'feature',
  root: TARGET,
  branch: 'feature',
  name: 'feature',
  main: false,
  closed: false,
  missing: false,
  repository: true,
  changedFiles: 0,
}
const CHECKOUTS: PullCheckoutsResponse = {
  available: true,
  checkouts: [{ root: TARGET, branch: 'feature', ...PULL }],
}
let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
let open: ReturnType<typeof vi.fn<(workspace: WorkspaceState) => Promise<void>>>
let mounted: boolean

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  invoke = vi.fn().mockResolvedValue(CHECKOUTS)
  open = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function render(workspaces = [WORKSPACE], activeWorkspaceId = 'main', disabled = false) {
  act(() =>
    root.render(
      <PullWorkspaceAction
        root={ROOT}
        pull={PULL}
        checkouts={CHECKOUTS}
        disabled={disabled}
        navigation={{ workspaces, activeWorkspaceId, open }}
        onCheckouts={vi.fn()}
      />,
    ),
  )
}

async function click(selector = 'button') {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(selector)?.click()
    await Promise.resolve()
  })
}

describe('PR workspace action', () => {
  it('revalidates checkout identity before opening the existing workspace', async () => {
    render()
    expect(host.textContent).toContain('feature')
    expect(host.textContent).toContain('Open workspace')
    await click()
    expect(invoke).toHaveBeenCalledWith('github:checkouts', { root: ROOT })
    expect(open).toHaveBeenCalledExactlyOnceWith(WORKSPACE)
  })

  it('labels current and closed workspaces explicitly', async () => {
    render([WORKSPACE], WORKSPACE.id)
    expect(host.textContent).toContain('Current workspace')
    expect(host.querySelector('button')).toBeNull()
    render([{ ...WORKSPACE, closed: true }])
    expect(host.textContent).toContain('Reopen workspace')
    await click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ closed: true }))
  })

  it('does not navigate when the checkout disappeared or changed branch', async () => {
    invoke.mockResolvedValue({ available: true, checkouts: [] })
    render()
    await click()
    expect(open).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/no longer/)
  })

  it('shows failed verification separately and never navigates', async () => {
    invoke.mockRejectedValue(new Error('Host disconnected'))
    render()
    await click()
    expect(open).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Host disconnected',
    )
  })

  it('offers paths when several workspaces match', () => {
    const second = { ...WORKSPACE, id: 'second', root: { ...TARGET, path: '/second' } }
    const checkouts = {
      available: true as const,
      checkouts: [
        { root: TARGET, ...PULL },
        { root: second.root, ...PULL },
      ],
    }
    act(() =>
      root.render(
        <PullWorkspaceAction
          root={ROOT}
          pull={PULL}
          checkouts={checkouts}
          disabled={false}
          navigation={{
            workspaces: [WORKSPACE, second],
            activeWorkspaceId: 'main',
            open,
          }}
          onCheckouts={vi.fn()}
        />,
      ),
    )
    expect(host.querySelector('summary')?.textContent).toBe('Choose workspace…')
    expect(host.textContent).toContain('/feature')
    expect(host.textContent).toContain('/second')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['unmount', 'disable', 'remove'] as const)(
    'rejects late verification after %s',
    async (change) => {
      let finish!: (value: PullCheckoutsResponse) => void
      invoke.mockReturnValue(
        new Promise<PullCheckoutsResponse>((resolve) => {
          finish = resolve
        }),
      )
      render()
      await click()
      if (change === 'unmount') {
        act(() => root.unmount())
        mounted = false
      } else if (change === 'disable') render([WORKSPACE], 'main', true)
      else render([])
      await act(async () => {
        finish(CHECKOUTS)
        await Promise.resolve()
      })
      expect(open).not.toHaveBeenCalled()
    },
  )
})
