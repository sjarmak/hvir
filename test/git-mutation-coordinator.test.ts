/* eslint-disable @typescript-eslint/unbound-method -- assertions inspect typed Vitest port mocks */

import { describe, expect, it, vi } from 'vitest'

import {
  GitMutationCoordinator,
  type GitMutationRegistryPort,
  type GitMutationWorkerPort,
  type GitMutationWorkspacePort,
} from '../src/main/git/mutation-coordinator'
import type { ProjectHost } from '../src/main/project-host'
import type {
  WorkspaceRemovalPort,
  WorkspaceTerminalPort,
} from '../src/main/workspace-removal-coordinator'
import { localPath, type ProjectState, type WorktreeDiscovery } from '../src/shared'

const root = localPath('/project')
const worktreeRoot = localPath('/project-worktree')
const staleRoot = localPath('/project-stale')

function projectState(): ProjectState {
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
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'workspace-2',
            root: worktreeRoot,
            name: 'project-worktree',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'workspace-stale',
            root: staleRoot,
            name: 'project-stale',
            main: false,
            closed: false,
            missing: true,
            prunableReason: 'gitdir file points to a missing location',
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function fixture() {
  const state = projectState()
  const registry: GitMutationRegistryPort = {
    active: {
      root,
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      host: { connectionState: 'connected' } as unknown as ProjectHost,
    },
    state: () => state,
    projectById: (id) => state.projects.find((project) => project.id === id),
    authorityForPath: () => undefined,
    reconcileWorktrees: vi.fn(() => Promise.resolve(state)),
  }
  const pruned: WorktreeDiscovery = {
    repository: true,
    worktrees: [
      { root, detached: false, bare: false },
      { root: worktreeRoot, detached: false, bare: false },
    ],
  }
  const worker: GitMutationWorkerPort = {
    discover: vi.fn(() => Promise.resolve(pruned)),
    pruneWorktrees: vi.fn(() => Promise.resolve(pruned)),
    addWorktree: vi.fn(() => Promise.resolve(pruned)),
    removeWorktree: vi.fn(() => Promise.resolve(pruned)),
    deleteHvirBranch: vi.fn(() => Promise.resolve(pruned)),
    switchBranch: vi.fn(() => Promise.resolve()),
    fetch: vi.fn(() => Promise.resolve()),
    pull: vi.fn(() => Promise.resolve()),
  }
  const coalesced: string[] = []
  const workspaces: GitMutationWorkspacePort = {
    serialize: <T>(operation: () => Promise<T>) => operation(),
    refresh: vi.fn(() => Promise.resolve(state)),
    scheduleRefresh: vi.fn(),
    coalesceProjectOperation: (projectId, operation) => {
      coalesced.push(projectId)
      return operation()
    },
    invalidateProject: vi.fn(),
    settleProject: vi.fn(() => Promise.resolve()),
    stopWatch: vi.fn(() => Promise.resolve()),
    replaceWatch: vi.fn(() => Promise.resolve()),
  }
  const removal: WorkspaceRemovalPort & WorkspaceTerminalPort = {
    removeMissingWorkspace: vi.fn(() => Promise.resolve(state)),
    workspaceTerminalIds: () => [],
  }
  const revoke = vi.fn()
  const authorizations = {
    grant: vi.fn(() => ({ id: 1, revoke })),
  }
  const errors: string[] = []
  const coordinator = new GitMutationCoordinator({
    registry,
    worker,
    workspaces,
    authorizations,
    removal,
    onError: (message) => errors.push(message),
  })
  return {
    coordinator,
    registry,
    worker,
    workspaces,
    removal,
    authorizations,
    revoke,
    coalesced,
    errors,
    state,
  }
}

describe('GitMutationCoordinator', () => {
  it('prunes only vanished Git records and revokes their owned resources', async () => {
    const {
      coordinator,
      registry,
      worker,
      workspaces,
      removal,
      authorizations,
      revoke,
      coalesced,
    } = fixture()

    await coordinator.pruneWorktrees('project-1')

    expect(workspaces.invalidateProject).toHaveBeenCalledWith('project-1')
    expect(workspaces.settleProject).toHaveBeenCalledWith('project-1')
    expect(coalesced).toEqual(['project-1'])
    expect(authorizations.grant).toHaveBeenCalledWith({
      kind: 'worktree-prune',
      projectId: 'project-1',
      root,
    })
    expect(worker.pruneWorktrees).toHaveBeenCalledWith(root)
    expect(revoke).toHaveBeenCalledOnce()
    expect(registry.reconcileWorktrees).toHaveBeenCalledOnce()
    expect(removal.removeMissingWorkspace).toHaveBeenCalledWith(
      'project-1',
      'workspace-stale',
    )
  })

  it('switches an existing branch with present worktree context and refreshes', async () => {
    const { coordinator, worker, authorizations, revoke, workspaces } = fixture()

    await coordinator.switchBranch(root, 'feature/review')

    expect(authorizations.grant).toHaveBeenCalledWith({
      kind: 'branch-switch',
      projectId: 'project-1',
      root,
      target: 'feature/review',
    })
    expect(worker.switchBranch).toHaveBeenCalledWith(root, 'feature/review', [
      root,
      worktreeRoot,
    ])
    expect(revoke).toHaveBeenCalledOnce()
    expect(workspaces.refresh).toHaveBeenCalledWith('project-1')
  })

  it('revokes a fetch grant when worker dispatch fails', async () => {
    const { coordinator, worker, revoke } = fixture()
    vi.mocked(worker.fetch).mockRejectedValueOnce(new Error('network failed'))

    await expect(coordinator.fetch(root)).rejects.toThrow('network failed')

    expect(revoke).toHaveBeenCalledOnce()
  })

  it('schedules recovery when refresh after pull fails', async () => {
    const { coordinator, worker, workspaces, errors, state } = fixture()
    vi.mocked(workspaces.refresh).mockRejectedValueOnce(new Error('refresh failed'))

    await expect(coordinator.pull(root)).resolves.toBe(state)

    expect(worker.pull).toHaveBeenCalledWith(root, [root, worktreeRoot])
    expect(workspaces.scheduleRefresh).toHaveBeenCalledWith('project-1')
    expect(errors).toEqual(['[git] workspace refresh after pull failed'])
  })

  it('refreshes project state and revokes authority after Git refuses a pull', async () => {
    const { coordinator, worker, workspaces, revoke } = fixture()
    vi.mocked(worker.pull).mockRejectedValueOnce(
      new Error('local changes would be overwritten'),
    )

    await expect(coordinator.pull(root)).rejects.toThrow(
      'local changes would be overwritten',
    )

    expect(revoke).toHaveBeenCalledOnce()
    expect(workspaces.refresh).toHaveBeenCalledWith('project-1')
  })

  it('adds the owned review worktree under an exact grant and names its workspace', async () => {
    const { coordinator, worker, authorizations, revoke, registry, state } = fixture()
    const added = localPath('/project.hvir-worktrees/review-1')
    const project = state.projects[0]!
    const withWorktree: ProjectState = {
      ...state,
      projects: [
        {
          ...project,
          workspaces: [
            ...project.workspaces,
            { ...project.workspaces[1]!, id: 'workspace-review', root: added },
          ],
        },
      ],
    }
    vi.mocked(registry.reconcileWorktrees).mockResolvedValueOnce(withWorktree)
    const commit = 'd'.repeat(40)

    await expect(coordinator.addWorktree(root, 'review-1', commit)).resolves.toEqual({
      projectId: 'project-1',
      workspaceId: 'workspace-review',
      root: added,
      branch: 'hvir/architecture/review-1',
    })

    const target = { branch: 'hvir/architecture/review-1', path: added.path, commit }
    expect(authorizations.grant).toHaveBeenCalledWith({
      kind: 'worktree-add',
      projectId: 'project-1',
      root,
      target,
    })
    expect(worker.addWorktree).toHaveBeenCalledWith(root, target)
    expect(revoke).toHaveBeenCalledOnce()
    expect(coordinator.worktreeTarget(root, 'review-1', commit)).toEqual(target)
    expect(() => coordinator.worktreeTarget(worktreeRoot, 'review-1', commit)).toThrow(
      'another workspace',
    )
  })

  it('refuses a worktree add for another workspace or a missing result', async () => {
    const { coordinator, worker, authorizations, revoke } = fixture()
    const commit = 'd'.repeat(40)

    await expect(
      coordinator.addWorktree(worktreeRoot, 'review-1', commit),
    ).rejects.toThrow('another workspace')
    expect(authorizations.grant).not.toHaveBeenCalled()

    await expect(coordinator.addWorktree(root, 'review-1', commit)).rejects.toThrow(
      'did not report the new worktree',
    )
    expect(worker.addWorktree).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
  })
})
