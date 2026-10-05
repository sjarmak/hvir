import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitEngine } from '../src/main/git/git-engine'
import {
  GitMutationAuthorization,
  type GitHostCallPermissions,
  type GitMutationAuthority,
} from '../src/main/git/mutation-authorization'
import {
  isPullWorktreeTarget,
  pullWorktreeArgs,
  pullWorktreeTarget,
  type PullWorktreeTarget,
} from '../src/main/git/pull-worktrees'
import { dispatchWorkerHostCall } from '../src/main/git/worker-host-broker'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import {
  asHostId,
  hostPath,
  localPath,
  type ExecResult,
  type HostPath,
  type WorkerHostCall,
} from '../src/shared'

type ExecHostCall = Extract<WorkerHostCall, { readonly operation: 'exec' }>

const root = hostPath(asHostId('dev'), '/work/repo')
const target = pullWorktreeTarget(root, 7, 'feature/x', 'origin')
const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function addCall(workspaceRoot: HostPath, args: readonly string[]): ExecHostCall {
  return {
    kind: 'host-call',
    callId: 1,
    hostId: workspaceRoot.hostId,
    operation: 'exec',
    command: 'git',
    args: ['-C', workspaceRoot.path, ...args],
  }
}

function authority(): GitMutationAuthority {
  const host = { hostId: root.hostId, connectionState: 'connected' } as ProjectHost
  return { projectId: 'project-1', root, host }
}

function grant(authorizations: GitMutationAuthorization, next: PullWorktreeTarget) {
  return authorizations.grant({
    kind: 'pull-worktree-add',
    projectId: 'project-1',
    root,
    target: next,
  })
}

describe('pull request worktree target', () => {
  it('places pr-<number> in the owned sibling directory and tracks the remote branch', () => {
    expect(target).toEqual({
      branch: 'feature/x',
      path: '/work/repo.hvir-worktrees/pr-7',
      remote: 'origin',
    })
    expect(pullWorktreeArgs(target)).toEqual([
      'worktree',
      'add',
      '--track',
      '-b',
      'feature/x',
      '/work/repo.hvir-worktrees/pr-7',
      'refs/remotes/origin/feature/x',
    ])
  })

  it.each([
    [0, 'feature', 'origin'],
    [1.5, 'feature', 'origin'],
    [7, '', 'origin'],
    [7, '-b', 'origin'],
    [7, '../main', 'origin'],
    [7, 'a//b', 'origin'],
    [7, 'a/', 'origin'],
    [7, 'x.lock', 'origin'],
    [7, 'a b', 'origin'],
    [7, 'a~1', 'origin'],
    [7, 'feature', '-origin'],
    [7, 'feature', 'or/igin'],
  ])('refuses #%s branch %j on remote %j', (number, branch, remote) => {
    expect(() => pullWorktreeTarget(root, number, branch, remote)).toThrow()
  })

  it('accepts every target it derives for generated branch names', () =>
    hegel.test(
      (tc) => {
        const number = tc.draw(gs.integers({ minValue: 1, maxValue: 1_000_000_000 }))
        const branch = tc.draw(
          gs.fromRegex(
            '[A-Za-z0-9_][A-Za-z0-9_+-]{0,12}(/[A-Za-z0-9_][A-Za-z0-9_+-]{0,12}){0,3}',
          ),
        )
        const remote = tc.draw(gs.fromRegex('[A-Za-z0-9][A-Za-z0-9_-]{0,20}'))
        const derived = pullWorktreeTarget(root, number, branch, remote)
        expect(isPullWorktreeTarget(root.path, derived)).toBe(true)
        expect(
          isPullWorktreeTarget(root.path, {
            ...derived,
            path: `${root.path}/pr-${number}`,
          }),
        ).toBe(false)
      },
      { testCases: 100, seed: 7 },
    ))
})

describe('pull-worktree-add grants', () => {
  it('consumes one exact grant for the exact argv', () => {
    const authorizations = new GitMutationAuthorization()
    grant(authorizations, target)
    const call = addCall(root, pullWorktreeArgs(target))

    expect(authorizations.permissionsFor(call, authority())).toEqual({
      allowPullWorktreeAdd: target,
    })
    expect(() => authorizations.permissionsFor(call, authority())).toThrow(
      'already consumed',
    )
  })

  it('denies an argv for another branch, path or remote', () => {
    const authorizations = new GitMutationAuthorization()
    grant(authorizations, target)
    for (const other of [
      { ...target, branch: 'main' },
      { ...target, path: '/work/repo.hvir-worktrees/pr-8' },
      { ...target, remote: 'upstream' },
    ]) {
      expect(() =>
        authorizations.permissionsFor(
          addCall(root, pullWorktreeArgs(other)),
          authority(),
        ),
      ).toThrow('no exact grant')
    }
  })

  it('refuses a grant outside the owned location', () => {
    const authorizations = new GitMutationAuthorization()
    for (const next of [
      { ...target, path: '/work/repo/pr-7' },
      { ...target, path: '/work/repo.hvir-worktrees/../repo' },
      { ...target, path: '/work/repo.hvir-worktrees/review-1' },
      { ...target, branch: '--orphan' },
    ]) {
      expect(() => grant(authorizations, next)).toThrow('Invalid Git mutation target')
    }
  })
})

describe('Git worker host broker: pull request worktree add', () => {
  it('runs only the exact granted argv', async () => {
    const rootPath = await tempRoot()
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const project = { host, root: localPath(rootPath) }
    const granted = pullWorktreeTarget(localPath(rootPath), 7, 'feature/x', 'origin')
    const call = addCall(localPath(rootPath), pullWorktreeArgs(granted))

    await expect(dispatchWorkerHostCall(call, project)).rejects.toThrow(
      'unauthorized pull worktree add',
    )
    await expect(
      dispatchWorkerHostCall(call, project, {
        allowPullWorktreeAdd: { ...granted, branch: 'feature/y' },
      }),
    ).rejects.toThrow('unauthorized pull worktree add')
    await expect(
      dispatchWorkerHostCall(call, project, {
        allowWorktreeAdd: {
          branch: 'feature/x',
          path: granted.path,
          commit: 'a'.repeat(40),
        },
      }),
    ).rejects.toThrow('unauthorized pull worktree add')
    expect(exec).not.toHaveBeenCalled()

    await dispatchWorkerHostCall(call, project, { allowPullWorktreeAdd: granted })
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', 'core.fsmonitor=false', ...call.args])
  })

  it('refuses a start point that is not the branch on the granted remote', async () => {
    const rootPath = await tempRoot()
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec')
    const project = { host, root: localPath(rootPath) }
    const granted = pullWorktreeTarget(localPath(rootPath), 7, 'feature/x', 'origin')
    const args = pullWorktreeArgs(granted)
    for (const start of ['HEAD', 'refs/remotes/origin/main', 'refs/heads/feature/x']) {
      await expect(
        dispatchWorkerHostCall(
          addCall(localPath(rootPath), [...args.slice(0, 6), start]),
          project,
          { allowPullWorktreeAdd: granted },
        ),
      ).rejects.toThrow()
    }
    await expect(
      dispatchWorkerHostCall(
        addCall(localPath(rootPath), [...args, '--force']),
        project,
        {
          allowPullWorktreeAdd: granted,
        },
      ),
    ).rejects.toThrow()
    expect(exec).not.toHaveBeenCalled()
  })

  it('creates a worktree whose branch tracks the pull request branch', async () => {
    const upstream = await tempRoot()
    git(upstream, ['init', '-b', 'main'])
    git(upstream, ['commit', '--allow-empty', '-m', 'base'])
    git(upstream, ['branch', 'feature/x'])
    const rootPath = await tempRoot()
    await rm(rootPath, { recursive: true, force: true })
    git(tmpdir(), ['clone', '--quiet', upstream, rootPath])
    const host = new LocalHost()
    const projectRoot = localPath(rootPath)
    const granted = pullWorktreeTarget(projectRoot, 7, 'feature/x', 'origin')
    const engine = new GitEngine(
      brokeredPort(host, projectRoot, { allowPullWorktreeAdd: granted }),
      projectRoot,
    )

    const discovery = await engine.pullWorktree(projectRoot, granted)

    expect(discovery.worktrees.map((worktree) => worktree.root.path)).toContain(
      granted.path,
    )
    expect(
      execFileSync(
        'git',
        [
          '-C',
          granted.path,
          'for-each-ref',
          '--format=%(upstream:remotename) %(upstream:remoteref)',
          'refs/heads/feature/x',
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('origin refs/heads/feature/x')
  })
})

async function tempRoot(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'hvir-pull-worktree-')))
  cleanups.push(path, `${path}.hvir-worktrees`)
  return path
}

function brokeredPort(
  host: LocalHost,
  projectRoot: HostPath,
  permissions: GitHostCallPermissions,
) {
  return {
    hostId: host.hostId,
    exec: (command: string, args: readonly string[]) =>
      dispatchWorkerHostCall(
        {
          kind: 'host-call',
          callId: 1,
          hostId: host.hostId,
          operation: 'exec',
          command,
          args,
        },
        { host, root: projectRoot },
        permissions,
      ) as Promise<ExecResult>,
    readTextFile: (path: HostPath) => host.readTextFile(path),
    readTextFilePrefix: (path: HostPath, maxBytes: number) =>
      host.readTextFilePrefix(path, maxBytes),
    stat: (path: HostPath) => host.stat(path),
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'hvir test',
      GIT_AUTHOR_EMAIL: 'hvir@example.test',
      GIT_COMMITTER_NAME: 'hvir test',
      GIT_COMMITTER_EMAIL: 'hvir@example.test',
    },
  })
}
