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
  type GitHostCallPermissions,
  type GitMutationAuthority,
} from '../src/main/git/mutation-authorization'
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
const commit = 'a'.repeat(40)
const target = hvirWorktreeTarget(root, 'review-1', commit)
const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function call(
  workspaceRoot: string,
  args: readonly string[],
  hostId = 'dev',
): ExecHostCall {
  return {
    kind: 'host-call',
    callId: 1,
    hostId,
    operation: 'exec',
    command: 'git',
    args: ['-C', workspaceRoot, ...args],
  }
}

const removeArgs = (next: HvirWorktreeTarget) => ['worktree', 'remove', next.path]
const deleteArgs = (next: HvirWorktreeTarget) => [
  'update-ref',
  '-d',
  `refs/heads/${next.branch}`,
  next.commit,
]

function authority(): GitMutationAuthority {
  const host = { hostId: root.hostId } as unknown as ProjectHost
  return { projectId: 'project-1', root, host }
}

describe('handoff worktree removal grants', () => {
  it('grants one exact worktree remove and one exact branch delete', () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant({
      kind: 'worktree-remove',
      projectId: 'project-1',
      root,
      target,
    })
    authorizations.grant({ kind: 'branch-delete', projectId: 'project-1', root, target })

    expect(
      authorizations.permissionsFor(call(root.path, removeArgs(target)), authority()),
    ).toEqual({ allowWorktreeRemove: target })
    expect(
      authorizations.permissionsFor(call(root.path, deleteArgs(target)), authority()),
    ).toEqual({ allowBranchDelete: target })
    expect(() =>
      authorizations.permissionsFor(call(root.path, removeArgs(target)), authority()),
    ).toThrow('already consumed')
  })

  it('refuses a grant for a branch outside hvir/architecture/, the main tree or an escaping path', () => {
    const authorizations = new GitMutationAuthorization()
    const forged = [
      { ...target, branch: 'main' },
      { ...target, branch: 'feature/review-1' },
      { ...target, path: root.path },
      { ...target, path: '/work/repo.hvir-worktrees/../repo' },
      { ...target, path: '/tmp/review-1' },
      { ...target, commit: 'HEAD' },
    ]
    for (const kind of ['worktree-remove', 'branch-delete'] as const)
      for (const next of forged)
        expect(() =>
          authorizations.grant({ kind, projectId: 'project-1', root, target: next }),
        ).toThrow('Invalid Git mutation target')
  })

  it('does not let a remove grant authorize the branch delete or another worktree', () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant({
      kind: 'worktree-remove',
      projectId: 'project-1',
      root,
      target,
    })
    const other = hvirWorktreeTarget(root, 'review-2', commit)

    expect(() =>
      authorizations.permissionsFor(call(root.path, deleteArgs(target)), authority()),
    ).toThrow('no exact grant')
    expect(() =>
      authorizations.permissionsFor(call(root.path, removeArgs(other)), authority()),
    ).toThrow('no exact grant')
  })
})

describe('Git worker host broker: handoff worktree removal', () => {
  it('runs only the granted remove and delete, with argv and never --force', async () => {
    const rootPath = await tempRoot()
    const host = new LocalHost()
    const exec = vi
      .spyOn(host, 'exec')
      .mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '' })
    const project = { host, root: localPath(rootPath) }
    const next = hvirWorktreeTarget(localPath(rootPath), 'review-1', commit)
    const remove = call(rootPath, removeArgs(next), 'local')
    const remove2 = call(rootPath, deleteArgs(next), 'local')

    await expect(dispatchWorkerHostCall(remove, project)).rejects.toThrow(
      'unauthorized worktree remove',
    )
    await expect(
      dispatchWorkerHostCall(remove2, project, { allowWorktreeRemove: next }),
    ).rejects.toThrow('unauthorized branch delete')
    await expect(
      dispatchWorkerHostCall(remove2, project, {
        allowBranchDelete: { ...next, commit: 'c'.repeat(40) },
      }),
    ).rejects.toThrow('unauthorized branch delete')
    expect(exec).not.toHaveBeenCalled()

    await dispatchWorkerHostCall(remove, project, { allowWorktreeRemove: next })
    await dispatchWorkerHostCall(remove2, project, { allowBranchDelete: next })
    expect(exec.mock.calls.map((args) => args[1])).toEqual([
      ['-c', 'core.fsmonitor=false', ...remove.args],
      ['-c', 'core.fsmonitor=false', ...remove2.args],
    ])
  })

  it('refuses a forced, escaping or injected removal even when granted', async () => {
    const rootPath = await tempRoot()
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec')
    const project = { host, root: localPath(rootPath) }
    const next = hvirWorktreeTarget(localPath(rootPath), 'review-1', commit)
    const forged: readonly (readonly string[])[] = [
      ['worktree', 'remove', '--force', next.path],
      ['worktree', 'remove', next.path, '--force'],
      ['worktree', 'remove', rootPath],
      ['worktree', 'remove', `${rootPath}.hvir-worktrees/../escape`],
      ['update-ref', '-d', 'refs/heads/main', next.commit],
      ['update-ref', '-d', `refs/heads/${next.branch}`],
      ['update-ref', '-d', `refs/heads/${next.branch}`, 'HEAD'],
      ['update-ref', '--no-deref', '-d', `refs/heads/${next.branch}`, next.commit],
    ]
    for (const args of forged)
      await expect(
        dispatchWorkerHostCall(call(rootPath, args, 'local'), project, {
          allowWorktreeRemove: next,
          allowBranchDelete: next,
        }),
      ).rejects.toThrow('forbidden git invocation')
    expect(exec).not.toHaveBeenCalled()
  })

  it('removes a real handoff worktree and its branch through GitEngine', async () => {
    const { rootPath, root: realRoot, next } = await handoffRepository()
    const engine = new GitEngine(
      brokeredPort(realRoot, { allowWorktreeRemove: next, allowBranchDelete: next }),
      realRoot,
    )

    const removed = await engine.hvirWorktree(realRoot, {
      operation: 'remove',
      target: next,
    })
    expect(removed.worktrees.map((worktree) => worktree.root.path)).not.toContain(
      next.path,
    )
    await engine.hvirWorktree(realRoot, { operation: 'delete-branch', target: next })
    expect(branches(rootPath)).not.toContain(next.branch)
  })

  it('leaves a worktree with changes in place: Git refuses without --force', async () => {
    const { rootPath, root: realRoot, next } = await handoffRepository()
    await writeFile(join(next.path, 'agent.txt'), 'work\n')
    const engine = new GitEngine(
      brokeredPort(realRoot, { allowWorktreeRemove: next }),
      realRoot,
    )

    await expect(
      engine.hvirWorktree(realRoot, { operation: 'remove', target: next }),
    ).rejects.toThrow(/modified or untracked/)
    expect(branches(rootPath)).toContain(next.branch)
  })
})

async function tempRoot(): Promise<string> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), 'hvir-broker-remove-')))
  cleanups.push(rootPath, `${rootPath}.hvir-worktrees`)
  return rootPath
}

async function handoffRepository() {
  const rootPath = await tempRoot()
  git(rootPath, ['init', '-b', 'main'])
  git(rootPath, ['config', 'user.email', 'hvir@example.test'])
  git(rootPath, ['config', 'user.name', 'hvir test'])
  git(rootPath, ['commit', '--allow-empty', '-m', 'base'])
  const head = execFileSync('git', ['-C', rootPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const realRoot = localPath(rootPath)
  const next = hvirWorktreeTarget(realRoot, 'review-1', head)
  git(rootPath, ['worktree', 'add', '-b', next.branch, next.path, next.commit])
  return { rootPath, root: realRoot, next }
}

function brokeredPort(root: HostPath, permissions: GitHostCallPermissions) {
  const host = new LocalHost()
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
        { host, root },
        permissions,
      ) as Promise<ExecResult>,
    readTextFile: (path: HostPath) => host.readTextFile(path),
    readTextFilePrefix: (path: HostPath, maxBytes: number) =>
      host.readTextFilePrefix(path, maxBytes),
    stat: (path: HostPath) => host.stat(path),
  }
}

function branches(rootPath: string): string {
  return execFileSync('git', ['-C', rootPath, 'branch', '--list'], { encoding: 'utf8' })
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}
