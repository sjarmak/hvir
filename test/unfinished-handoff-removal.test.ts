import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitEngine } from '../src/main/git/git-engine'
import {
  hvirWorktreeTarget,
  type HvirWorktreeTarget,
} from '../src/main/git/hvir-worktrees'
import {
  GitMutationAuthorization,
  type GitMutationGrantRequest,
} from '../src/main/git/mutation-authorization'
import {
  GitMutationCoordinator,
  type GitMutationRegistryPort,
  type GitMutationWorkerPort,
} from '../src/main/git/mutation-coordinator'
import {
  GitWorkerHostRouter,
  type GitWorkerAuthorityPort,
} from '../src/main/git/worker-host-router'
import { LocalHost } from '../src/main/project-host'
import {
  ARCHITECTURE_BRIEF_FILE,
  hostPathEquals,
  localPath,
  type ExecResult,
  type HostPath,
  type ProjectState,
  type RegisteredProjectState,
  type WorkspaceState,
  type WorktreeDiscovery,
} from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('removing an unfinished handoff', () => {
  it('lists only worktrees that qualify, read fresh from disk and Git', async () => {
    const f = await fixture()
    // The active handoff is marked too; only its removal waits for another selection.
    await expect(f.coordinator.unfinishedHandoffs('project-1')).resolves.toEqual([
      'review-1',
      'active',
    ])

    await writeFile(join(f.target.path, ARCHITECTURE_BRIEF_FILE), 'brief\n')
    await expect(f.coordinator.unfinishedHandoffs('project-1')).resolves.toEqual([
      'active',
    ])
    await expect(f.coordinator.unfinishedHandoffs('other-project')).resolves.toEqual([])
  })

  it('removes the worktree and deletes its branch under two exact one-shot grants', async () => {
    const f = await fixture()

    await f.coordinator.removeUnfinishedHandoff('project-1', 'review-1')

    expect(git(f.rootPath, ['worktree', 'list', '--porcelain'])).not.toContain(
      f.target.path,
    )
    expect(git(f.rootPath, ['branch', '--list'])).not.toContain(f.target.branch)
    expect(f.grants).toEqual([
      { kind: 'worktree-remove', projectId: 'project-1', root: f.root, target: f.target },
      { kind: 'branch-delete', projectId: 'project-1', root: f.root, target: f.target },
    ])
    expect(f.removeMissingWorkspace).toHaveBeenCalledWith('project-1', 'review-1')
  })

  it.each([
    ['an unknown workspace', 'project-1', 'nope', 'Unknown workspace'],
    ['a workspace of another project', 'other-project', 'review-1', 'Unknown project'],
    ['the main working tree', 'project-1', 'main', 'main working tree'],
    ['the active workspace', 'project-1', 'active', 'Select another workspace'],
    ['a branch outside hvir/architecture/', 'project-1', 'feature', 'hvir/architecture/'],
  ] as const)(
    'refuses %s without issuing a grant',
    async (_label, projectId, workspaceId, message) => {
      const f = await fixture()

      await expect(
        f.coordinator.removeUnfinishedHandoff(projectId, workspaceId),
      ).rejects.toThrow(message)
      expect(f.grants).toEqual([])
      expect(git(f.rootPath, ['branch', '--list'])).toContain(f.target.branch)
    },
  )

  it('refuses a worktree whose branch has commits', async () => {
    const f = await fixture()
    git(f.target.path, ['commit', '--allow-empty', '-m', 'agent work'])

    await expect(
      f.coordinator.removeUnfinishedHandoff('project-1', 'review-1'),
    ).rejects.toThrow('commits')
    expect(f.grants).toEqual([])
  })

  it('refuses a worktree with uncommitted changes', async () => {
    const f = await fixture()
    await writeFile(join(f.target.path, 'agent.txt'), 'work\n')

    await expect(
      f.coordinator.removeUnfinishedHandoff('project-1', 'review-1'),
    ).rejects.toThrow('changes')
    expect(f.grants).toEqual([])
    expect(git(f.rootPath, ['worktree', 'list', '--porcelain'])).toContain(f.target.path)
  })

  it('refuses a registered workspace whose path escapes the owned location', async () => {
    const f = await fixture()
    const escape = f.workspace('review-1', {
      id: 'escape',
      root: localPath(`${f.rootPath}.hvir-worktrees/../${f.rootPath.split('/').pop()}`),
    })

    await expect(
      f.coordinator.removeUnfinishedHandoff('project-1', escape.id),
    ).rejects.toThrow('Cannot remove')
    expect(f.grants).toEqual([])
  })

  it('refuses a worktree with an hvir terminal session', async () => {
    const f = await fixture({ terminalIds: ['terminal-1'] })

    await expect(
      f.coordinator.removeUnfinishedHandoff('project-1', 'review-1'),
    ).rejects.toThrow('terminal')
    expect(f.grants).toEqual([])
  })
})

async function fixture(options: { readonly terminalIds?: readonly string[] } = {}) {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), 'hvir-handoff-remove-')))
  cleanups.push(rootPath, `${rootPath}.hvir-worktrees`)
  git(rootPath, ['init', '-b', 'main'])
  git(rootPath, ['config', 'user.email', 'hvir@example.test'])
  git(rootPath, ['config', 'user.name', 'hvir test'])
  git(rootPath, ['commit', '--allow-empty', '-m', 'base'])
  const head = git(rootPath, ['rev-parse', 'HEAD']).trim()
  const root = localPath(rootPath)
  const target = hvirWorktreeTarget(root, 'review-1', head)
  const active = hvirWorktreeTarget(root, 'active', head)
  git(rootPath, ['worktree', 'add', '-b', target.branch, target.path, head])
  git(rootPath, ['worktree', 'add', '-b', active.branch, active.path, head])
  const feature = `${rootPath}.hvir-worktrees/feature`
  git(rootPath, ['worktree', 'add', '-b', 'feature/review', feature, head])

  const host = new LocalHost()
  const workspaces: WorkspaceState[] = [
    workspace('main', root, 'main', head, true),
    workspace('review-1', localPath(target.path), target.branch, head),
    workspace('active', localPath(active.path), active.branch, head),
    workspace('feature', localPath(feature), 'feature/review', head),
  ]
  const project = (): RegisteredProjectState => ({
    id: 'project-1',
    registeredRoot: root,
    displayName: 'project',
    connectionState: 'connected',
    watchTier: 'native',
    activeWorkspaceId: 'active',
    workspaces,
  })
  const state = (): ProjectState => ({
    revision: 0,
    root: localPath(active.path),
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'active',
    projects: [project()],
  })
  const authority: GitWorkerAuthorityPort = {
    authorityForPath: (hostId, path) =>
      hostId === host.hostId && (path === rootPath || path.startsWith(`${rootPath}/`))
        ? { host, root, projectId: 'project-1' }
        : undefined,
  }
  const registry: GitMutationRegistryPort = {
    active: {
      root: localPath(active.path),
      projectId: 'project-1',
      workspaceId: 'active',
      host,
    },
    state,
    projectById: (id) => (id === 'project-1' ? project() : undefined),
    authorityForPath: (hostId, path) => authority.authorityForPath(hostId, path),
    reconcileWorktrees: (_projectId, discovery: WorktreeDiscovery) => {
      for (const [index, known] of workspaces.entries())
        if (
          !discovery.worktrees.some((listed) => hostPathEquals(listed.root, known.root))
        )
          workspaces[index] = { ...known, missing: true }
      return Promise.resolve(state())
    },
  }
  const authorizations = new GitMutationAuthorization()
  const grants: GitMutationGrantRequest[] = []
  const grant = authorizations.grant.bind(authorizations)
  vi.spyOn(authorizations, 'grant').mockImplementation((request) => {
    grants.push(request)
    return grant(request)
  })
  const router = new GitWorkerHostRouter({ authority, authorizations })
  const engine = new GitEngine(
    {
      hostId: host.hostId,
      exec: (command, args) =>
        router.route({
          kind: 'host-call',
          callId: 1,
          hostId: host.hostId,
          operation: 'exec',
          command,
          args,
        }) as Promise<ExecResult>,
      readTextFile: (path) => host.readTextFile(path),
      readTextFilePrefix: (path, maxBytes) => host.readTextFilePrefix(path, maxBytes),
      stat: (path) => host.stat(path),
    },
    root,
  )
  const change =
    (operation: 'add' | 'remove' | 'delete-branch') =>
    (at: HostPath, next: HvirWorktreeTarget) =>
      engine.hvirWorktree(at, { operation, target: next })
  const worker: GitMutationWorkerPort = {
    discover: (at) => engine.worktrees(at),
    pruneWorktrees: (at) => engine.pruneWorktrees(at),
    addWorktree: change('add'),
    removeWorktree: change('remove'),
    deleteHvirBranch: change('delete-branch'),
    switchBranch: () => Promise.reject(new Error('unused')),
    fetch: () => Promise.reject(new Error('unused')),
    pull: () => Promise.reject(new Error('unused')),
  }
  const removeMissingWorkspace = vi.fn((_projectId: string, id: string) => {
    workspaces.splice(
      workspaces.findIndex((candidate) => candidate.id === id),
      1,
    )
    return Promise.resolve(state())
  })
  const coordinator = new GitMutationCoordinator({
    registry,
    worker,
    workspaces: {
      serialize: (operation) => operation(),
      refresh: () => Promise.resolve(state()),
      scheduleRefresh: () => undefined,
      coalesceProjectOperation: (_projectId, operation) => operation(),
      invalidateProject: () => undefined,
      settleProject: () => Promise.resolve(),
      stopWatch: () => Promise.resolve(),
      replaceWatch: () => Promise.resolve(),
    },
    authorizations,
    removal: {
      removeMissingWorkspace,
      workspaceTerminalIds: () => options.terminalIds ?? [],
    },
  })
  return {
    rootPath,
    root,
    target,
    coordinator,
    grants,
    removeMissingWorkspace,
    workspace: (id: string, overrides: Partial<WorkspaceState>): WorkspaceState => {
      const next = {
        ...workspaces.find((candidate) => candidate.id === id)!,
        ...overrides,
      }
      workspaces.push(next)
      return next
    },
  }
}

function workspace(
  id: string,
  root: HostPath,
  branch: string,
  head: string,
  main = false,
): WorkspaceState {
  return {
    id,
    root,
    name: branch,
    head,
    branch,
    main,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}
