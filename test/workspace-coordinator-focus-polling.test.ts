import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectHost } from '../src/main/project-host'
import {
  WorkspaceCoordinator,
  type WindowFocusPort,
  type WorkspaceDiscoveryPort,
  type WorkspaceRegistryPort,
} from '../src/main/workspace-coordinator'
import {
  WORKSPACE_ACTIVITY_FIELDS,
  WORKSPACE_ACTIVITY_SCHEMA,
  WORKSPACE_ACTIVITY_STATUS_LIMIT,
  localPath,
  type ProjectState,
  type WorkspaceActivityResult,
  type WorktreeDiscovery,
} from '../src/shared'

const root = localPath('/project')
const host = {
  hostId: root.hostId,
  connectionState: 'connected',
  watchTier: 'native',
} as unknown as ProjectHost

const discovered: WorktreeDiscovery = {
  repository: true,
  worktrees: [{ root, detached: false, bare: false }],
}

const activity: WorkspaceActivityResult = {
  changedFiles: 0,
  status: {
    schema: WORKSPACE_ACTIVITY_SCHEMA,
    fields: WORKSPACE_ACTIVITY_FIELDS,
    statusLimit: WORKSPACE_ACTIVITY_STATUS_LIMIT,
    statusEntryCount: 0,
    statusTruncated: false,
    statusDigest: '0'.repeat(64),
  },
}

function projectState(closed = false): ProjectState {
  return {
    revision: 0,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-1',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root,
            name: 'project',
            main: true,
            closed,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function fakeFocus(initial: boolean) {
  let focused = initial
  const listeners = new Set<() => void>()
  const port: WindowFocusPort = {
    isFocused: () => focused,
    observe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    port,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      focused = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function fixture(focus?: WindowFocusPort, closed = false) {
  const state = projectState(closed)
  const registry: WorkspaceRegistryPort = {
    active: { host, root, projectId: 'project-1', workspaceId: 'workspace-1' },
    state: () => state,
    projectById: (id) => state.projects.find((project) => project.id === id),
    reconcileWorktrees: () => Promise.resolve(state),
    updateWorkspaceActivity: () => Promise.resolve(state),
  }
  const discovery = {
    discover: vi.fn<() => Promise<WorktreeDiscovery>>(() => Promise.resolve(discovered)),
    workspaceActivity: vi.fn<WorkspaceDiscoveryPort['workspaceActivity']>(() =>
      Promise.resolve(activity),
    ),
  }
  const coordinator = new WorkspaceCoordinator({
    registry,
    discovery,
    removal: { removeMissingWorkspace: vi.fn() },
    emitWatch: vi.fn(),
    createWatch: vi.fn() as never,
    ...(focus ? { focus } : {}),
  })
  return { coordinator, discovery }
}

describe('workspace polling cadence and focus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 30 seconds by default', async () => {
    const { coordinator, discovery } = fixture()
    coordinator.startPolling()

    await vi.advanceTimersByTimeAsync(29_999)
    expect(discovery.discover).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(discovery.discover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(discovery.discover).toHaveBeenCalledTimes(2)
    await coordinator.dispose()
  })

  it('runs no polls while no window is focused', async () => {
    const focus = fakeFocus(false)
    const { coordinator, discovery } = fixture(focus.port)
    coordinator.startPolling()

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(discovery.discover).not.toHaveBeenCalled()
    await coordinator.dispose()
  })

  it('polls at the cadence while a window starts focused', async () => {
    const focus = fakeFocus(true)
    const { coordinator, discovery } = fixture(focus.port)
    coordinator.startPolling()

    await vi.advanceTimersByTimeAsync(30_000)

    expect(discovery.discover).toHaveBeenCalledTimes(1)
    await coordinator.dispose()
  })

  it('polls immediately on focus gain and then resumes the cadence', async () => {
    const focus = fakeFocus(false)
    const { coordinator, discovery } = fixture(focus.port)
    coordinator.startPolling()
    await vi.advanceTimersByTimeAsync(45_000)

    focus.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(discovery.discover).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(discovery.discover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(discovery.discover).toHaveBeenCalledTimes(2)
    await coordinator.dispose()
  })

  it('stops the timer on blur and does not poll again until focus returns', async () => {
    const focus = fakeFocus(true)
    const { coordinator, discovery } = fixture(focus.port)
    coordinator.startPolling()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(discovery.discover).toHaveBeenCalledTimes(1)

    focus.set(false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(discovery.discover).toHaveBeenCalledTimes(1)

    focus.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(discovery.discover).toHaveBeenCalledTimes(2)
    await coordinator.dispose()
  })

  it('does not poll again when a focus notification repeats the same state', async () => {
    const focus = fakeFocus(true)
    const { coordinator, discovery } = fixture(focus.port)
    coordinator.startPolling()

    focus.set(true)
    focus.set(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(discovery.discover).not.toHaveBeenCalled()
    await coordinator.dispose()
  })

  it('releases the focus subscription when polling stops or the coordinator is disposed', async () => {
    const focus = fakeFocus(true)
    const first = fixture(focus.port)
    first.coordinator.startPolling()
    expect(focus.listenerCount()).toBe(1)
    first.coordinator.stopPolling()
    expect(focus.listenerCount()).toBe(0)

    const second = fixture(focus.port)
    second.coordinator.startPolling()
    await second.coordinator.dispose()
    expect(focus.listenerCount()).toBe(0)
    focus.set(false)
    focus.set(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(second.discovery.discover).not.toHaveBeenCalled()
  })

  it('samples a clean closed workspace on each focused poll and never while unfocused', async () => {
    const focus = fakeFocus(true)
    const { coordinator, discovery } = fixture(focus.port, true)
    coordinator.startPolling()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(discovery.workspaceActivity).toHaveBeenCalledTimes(2)
    expect(discovery.workspaceActivity).toHaveBeenCalledWith(root, [root])

    focus.set(false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(discovery.workspaceActivity).toHaveBeenCalledTimes(2)
    await coordinator.dispose()
  })

  it('does not sample an open workspace on a periodic poll', async () => {
    const focus = fakeFocus(true)
    const { coordinator, discovery } = fixture(focus.port)
    coordinator.startPolling()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(discovery.discover).toHaveBeenCalledTimes(2)
    expect(discovery.workspaceActivity).not.toHaveBeenCalled()
    await coordinator.dispose()
  })
})
