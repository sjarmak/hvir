import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectHost } from '../src/main/project-host'
import { ProjectWatchController } from '../src/main/project-watch'
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
  type HostPath,
  type ProjectState,
  type WatchEvent,
  type WorkspaceActivityResult,
  type WorktreeDiscovery,
} from '../src/shared'

const PULSE_INTERVAL_MS = 2_000
const roots = Array.from({ length: 24 }, (_, index) =>
  localPath(index === 0 ? '/omni' : `/omni-wt/worktree-${String(index)}`),
)
const activeRoot = localPath('/omni')
const gitDirectory = localPath('/omni/.git')

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

function projectState(): ProjectState {
  return {
    revision: 0,
    root: activeRoot,
    connectionState: 'connected',
    watchTier: 'polling',
    activeProjectId: 'omni',
    activeWorkspaceId: 'workspace-0',
    projects: [
      {
        id: 'omni',
        registeredRoot: activeRoot,
        displayName: 'omni',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: 'workspace-0',
        workspaces: roots.map((root, index) => ({
          id: `workspace-${String(index)}`,
          root,
          name: root.path,
          head: 'abc123',
          branch: `branch-${String(index)}`,
          main: index === 0,
          closed: index !== 0,
          missing: false,
          repository: true,
          changedFiles: 0,
        })),
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
    set(next: boolean) {
      focused = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function fixture(focused: boolean) {
  const focus = fakeFocus(focused)
  const state = projectState()
  const watches: Array<{
    readonly path: HostPath
    readonly receive: (event: WatchEvent) => void
  }> = []
  const host = {
    hostId: activeRoot.hostId,
    connectionState: 'connected',
    watchTier: 'polling',
    exec: () =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: `${gitDirectory.path}\n`,
        stderr: '',
      }),
    watch: (path: HostPath, receive: (event: WatchEvent) => void) => {
      watches.push({ path, receive })
      return () => undefined
    },
  } as unknown as ProjectHost
  const registry: WorkspaceRegistryPort = {
    active: { host, root: activeRoot, projectId: 'omni', workspaceId: 'workspace-0' },
    state: () => state,
    projectById: (id) => state.projects.find((project) => project.id === id),
    reconcileWorktrees: () => Promise.resolve(state),
    updateWorkspaceActivity: () => Promise.resolve(state),
  }
  const discovered: WorktreeDiscovery = {
    repository: true,
    worktrees: roots.map((root, index) => ({
      root,
      head: 'abc123',
      branch: `branch-${String(index)}`,
      detached: false,
      bare: false,
    })),
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
    createWatch: (target, callbacks) => new ProjectWatchController(target, callbacks),
    focus: focus.port,
  })
  const pulse = (): void => {
    for (const watch of watches) {
      watch.receive({ type: 'change', path: watch.path, synthetic: 'refresh' })
    }
  }
  const pulseFor = async (durationMs: number): Promise<void> => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += PULSE_INTERVAL_MS) {
      pulse()
      await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS)
    }
  }
  const start = async (): Promise<void> => {
    await coordinator.replaceWatch({ host, root: activeRoot, projectId: 'omni' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watches.map((watch) => watch.path)).toEqual([activeRoot, gitDirectory])
    discovery.discover.mockClear()
    discovery.workspaceActivity.mockClear()
  }
  const sampledRoots = (): string[] =>
    discovery.workspaceActivity.mock.calls.map(([root]) => root.path)
  return { coordinator, discovery, focus, watches, pulseFor, start, sampledRoots }
}

describe('SSH refresh pulses and workspace Git sampling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs no Git refresh for refresh pulses while no hvir window is focused', async () => {
    const { coordinator, discovery, pulseFor, start, sampledRoots } = fixture(false)
    await start()

    await pulseFor(60_000)

    expect(sampledRoots()).toEqual([])
    expect(discovery.discover).not.toHaveBeenCalled()
    await coordinator.dispose()
  })

  it('refreshes the active workspace for real Git metadata events while unfocused', async () => {
    const { coordinator, watches, start, sampledRoots } = fixture(false)
    await start()

    const gitWatch = watches.find((watch) => watch.path.path === gitDirectory.path)
    gitWatch?.receive({ type: 'change', path: localPath('/omni/.git/index') })
    await vi.advanceTimersByTimeAsync(400)

    expect(sampledRoots()).toEqual([activeRoot.path])
    await coordinator.dispose()
  })

  it('resumes pulse-driven refreshes once a window gains focus', async () => {
    const { coordinator, focus, pulseFor, start, sampledRoots } = fixture(false)
    await start()
    await pulseFor(10_000)
    expect(sampledRoots()).toEqual([])

    focus.set(true)
    await pulseFor(PULSE_INTERVAL_MS)

    expect(sampledRoots()).toContain(activeRoot.path)
    await coordinator.dispose()
  })

  it('samples closed workspaces at most once per thirty seconds under focused pulses', async () => {
    const { coordinator, pulseFor, start, sampledRoots } = fixture(true)
    await start()

    await pulseFor(60_000)

    const counts = new Map<string, number>()
    for (const root of sampledRoots()) counts.set(root, (counts.get(root) ?? 0) + 1)
    expect(counts.get(activeRoot.path)).toBeGreaterThanOrEqual(25)
    for (const root of roots.slice(1)) {
      expect(counts.get(root.path) ?? 0).toBeGreaterThanOrEqual(1)
      expect(counts.get(root.path) ?? 0).toBeLessThanOrEqual(2)
    }
    await coordinator.dispose()
  })
})
