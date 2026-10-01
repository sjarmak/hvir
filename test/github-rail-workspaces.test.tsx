// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { GitHubRailPanel } from '../src/renderer/src/github/GitHubRail'
import { asHostId, hostPath, type ProjectState } from '../src/shared'

it.each([false, true])(
  'routes a PR action through the existing workspace owner (closed=%s)',
  async (closed) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const source = hostPath(asHostId('local'), '/repo')
    const target = hostPath(source.hostId, '/repo-feature')
    const state: ProjectState = {
      revision: 1,
      root: source,
      connectionState: 'connected',
      watchTier: 'native',
      activeProjectId: 'project',
      activeWorkspaceId: 'main',
      projects: [
        {
          id: 'project',
          registeredRoot: source,
          displayName: 'Repo',
          connectionState: 'connected',
          watchTier: 'native',
          activeWorkspaceId: 'main',
          workspaces: [
            {
              id: 'feature',
              root: target,
              name: 'feature',
              main: false,
              closed,
              missing: false,
              repository: true,
              changedFiles: 0,
              branch: 'feature',
            },
          ],
        },
      ],
    }
    const switchWorkspace = vi.fn().mockResolvedValue(undefined)
    const reopenWorkspace = vi.fn().mockResolvedValue(undefined)
    const invoke = vi.fn(async (channel: string) => {
      await Promise.resolve()
      if (channel === 'github:checkouts')
        return {
          available: true,
          checkouts: [
            {
              root: target,
              branch: 'feature',
              headRepo: 'acme/repo',
              headRef: 'feature',
            },
          ],
        }
      if (channel === 'github:pulls')
        return {
          available: true,
          repo: 'acme/repo',
          viewer: 'alice',
          branch: 'main',
          branchPulls: [],
          reviewRequested: [],
          authored: [
            {
              number: 7,
              title: 'Feature',
              url: 'https://github.com/acme/repo/pull/7',
              state: 'open',
              draft: false,
              headRef: 'feature',
              headRepo: 'acme/repo',
              author: 'alice',
              updatedAt: '',
              checks: 'none',
              review: 'none',
              openFeedback: 0,
            },
          ],
        }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <GitHubRailPanel
            github={{ pullsEnabled: true }}
            layout={{ railMode: 'pulls' }}
            session={{
              root: source,
              connectionState: 'connected',
              projectState: state,
              switchWorkspace,
              reopenWorkspace,
            }}
          />,
        )
        await Promise.resolve()
      })
      const label = `${closed ? 'Reopen' : 'Open'} workspace for PR #7`
      const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
      expect(button).not.toBeNull()
      expect(button?.closest('a')).toBeNull()
      expect(host.querySelector('a')?.href).toBe('https://github.com/acme/repo/pull/7')
      await act(async () => {
        button?.click()
        await Promise.resolve()
      })
      expect(closed ? reopenWorkspace : switchWorkspace).toHaveBeenCalledExactlyOnceWith(
        'project',
        'feature',
      )
      expect(closed ? switchWorkspace : reopenWorkspace).not.toHaveBeenCalled()
    } finally {
      act(() => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  },
)
