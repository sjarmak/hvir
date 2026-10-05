// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PullWorkspaceAction } from '../src/renderer/src/github/PullWorkspaceAction'
import {
  asHostId,
  hostPath,
  type ProjectState,
  type PullSummary,
  type WorkspaceState,
} from '../src/shared'
import type { PullCheckoutsResponse } from '../src/shared/github'

const ROOT = hostPath(asHostId('local'), '/repo')
const TARGET = hostPath(ROOT.hostId, '/feature')
const PULL = {
  number: 7,
  state: 'open',
  headRef: 'feature',
  headRepo: 'acme/repo',
} as PullSummary
const NO_CHECKOUTS: PullCheckoutsResponse = { available: true, checkouts: [] }
const CREATED_STATE = { activeWorkspaceId: 'main' } as ProjectState
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
let acceptProjectState: ReturnType<typeof vi.fn<(state: ProjectState) => void>>
let onCheckouts: ReturnType<typeof vi.fn<(response: PullCheckoutsResponse) => void>>
let mounted: boolean

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  invoke = vi.fn().mockResolvedValue(CHECKOUTS)
  open = vi.fn().mockResolvedValue(undefined)
  acceptProjectState = vi.fn()
  onCheckouts = vi.fn()
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function render(
  workspaces = [WORKSPACE],
  activeWorkspaceId = 'main',
  disabled = false,
  { pull = PULL, checkouts = CHECKOUTS } = {},
) {
  act(() =>
    root.render(
      <PullWorkspaceAction
        root={ROOT}
        pull={pull}
        checkouts={checkouts}
        repo="Acme/Repo"
        disabled={disabled}
        navigation={{ workspaces, activeWorkspaceId, open, acceptProjectState }}
        onCheckouts={onCheckouts}
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
          repo="acme/repo"
          disabled={false}
          navigation={{
            workspaces: [WORKSPACE, second],
            activeWorkspaceId: 'main',
            open,
            acceptProjectState,
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

  describe('without a checkout', () => {
    const none = { checkouts: NO_CHECKOUTS }

    it('creates a worktree, adopts the new project state and rereads checkouts', async () => {
      invoke
        .mockResolvedValueOnce({ ok: true, value: CREATED_STATE })
        .mockResolvedValueOnce(CHECKOUTS)
      render([WORKSPACE], 'main', false, none)
      expect(host.textContent).toContain('Create worktree')
      await click('[aria-label="Create worktree for PR #7"]')
      expect(invoke).toHaveBeenNthCalledWith(1, 'github:create-worktree', {
        root: ROOT,
        number: 7,
      })
      expect(acceptProjectState).toHaveBeenCalledExactlyOnceWith(CREATED_STATE)
      expect(invoke).toHaveBeenNthCalledWith(2, 'github:checkouts', { root: ROOT })
      expect(onCheckouts).toHaveBeenCalledExactlyOnceWith(CHECKOUTS)
      expect(open).not.toHaveBeenCalled()
    })

    it('reports a refused creation without adopting any state', async () => {
      invoke.mockResolvedValue({
        ok: false,
        error: "a branch named 'feature' already exists",
      })
      render([WORKSPACE], 'main', false, none)
      await click('[aria-label="Create worktree for PR #7"]')
      expect(acceptProjectState).not.toHaveBeenCalled()
      expect(onCheckouts).not.toHaveBeenCalled()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'already exists',
      )
    })

    it('says the worktree exists when only the checkout reread fails', async () => {
      invoke
        .mockResolvedValueOnce({ ok: true, value: CREATED_STATE })
        .mockRejectedValueOnce(new Error('gh timed out'))
      render([WORKSPACE], 'main', false, none)
      await click('[aria-label="Create worktree for PR #7"]')
      expect(acceptProjectState).toHaveBeenCalledExactlyOnceWith(CREATED_STATE)
      expect(host.querySelector('[role="alert"]')?.textContent).toMatch(
        /Created the worktree, but could not refresh checkouts: gh timed out/,
      )
    })

    it.each([
      ['a fork', { ...PULL, headRepo: 'someone/repo' }],
      ['a closed PR', { ...PULL, state: 'closed' as const }],
    ])('offers no creation for %s', (_label, pull) => {
      render([WORKSPACE], 'main', false, { ...none, pull })
      expect(host.textContent).toContain('No checkout')
      expect(host.querySelector('button')).toBeNull()
    })

    it('offers no creation while the checkout is unverified', () => {
      render([WORKSPACE], 'main', false, {
        checkouts: { available: true, checkouts: [{ root: TARGET, branch: 'feature' }] },
      })
      expect(host.textContent).toContain('Checkout unverified')
      expect(host.querySelector('button')).toBeNull()
    })
  })
})
