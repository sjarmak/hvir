import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitEngine } from '../src/main/git/git-engine'
import {
  hvirWorktreeTarget,
  type HvirWorktreeTarget,
} from '../src/main/git/hvir-worktrees'
import type { GitHostCallPermissions } from '../src/main/git/mutation-authorization'
import { dispatchWorkerHostCall } from '../src/main/git/worker-host-broker'
import { LocalHost } from '../src/main/project-host'
import { localPath, type ExecResult, type WorkerHostCall } from '../src/shared'

type ExecHostCall = Extract<WorkerHostCall, { readonly operation: 'exec' }>

const cleanups: string[] = []
const commit = 'b'.repeat(40)

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function addCall(root: string, target: HvirWorktreeTarget): ExecHostCall {
  return {
    kind: 'host-call',
    callId: 1,
    hostId: 'local',
    operation: 'exec',
    command: 'git',
    args: [
      '-C',
      root,
      'worktree',
      'add',
      '-b',
      target.branch,
      target.path,
      target.commit,
    ],
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-broker-add-'))
  cleanups.push(root, `${root}.hvir-worktrees`)
  return root
}

describe('Git worker host broker: worktree add', () => {
  it('runs only the exact granted worktree add, with argv and no shell', async () => {
    const rootPath = await tempRoot()
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec').mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    })
    const project = { host, root: localPath(rootPath) }
    const target = hvirWorktreeTarget(localPath(rootPath), 'review-1', commit)
    const call = addCall(rootPath, target)

    await expect(dispatchWorkerHostCall(call, project)).rejects.toThrow(
      'unauthorized worktree add',
    )
    await expect(
      dispatchWorkerHostCall(call, project, {
        allowWorktreeAdd: { ...target, commit: 'c'.repeat(40) },
      }),
    ).rejects.toThrow('unauthorized worktree add')
    expect(exec).not.toHaveBeenCalled()

    await dispatchWorkerHostCall(call, project, { allowWorktreeAdd: target })
    expect(exec).toHaveBeenCalledOnce()
    expect(exec.mock.calls[0]?.[0]).toBe('git')
    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', 'core.fsmonitor=false', ...call.args])
  })

  it('refuses an escaping path, an injected ref or option even when granted', async () => {
    const rootPath = await tempRoot()
    const host = new LocalHost()
    const exec = vi.spyOn(host, 'exec')
    const project = { host, root: localPath(rootPath) }
    const target = hvirWorktreeTarget(localPath(rootPath), 'review-1', commit)
    const forged: readonly HvirWorktreeTarget[] = [
      { ...target, path: `${rootPath}.hvir-worktrees/../escape` },
      { ...target, path: join(rootPath, 'inside') },
      { ...target, branch: '--orphan' },
      { ...target, branch: 'hvir/architecture/../../main' },
      { ...target, commit: 'HEAD~1' },
    ]
    for (const next of forged)
      await expect(
        dispatchWorkerHostCall(addCall(rootPath, next), project, {
          allowWorktreeAdd: next,
        }),
      ).rejects.toThrow('forbidden git invocation')
    const extra: ExecHostCall = {
      ...addCall(rootPath, target),
      args: [...addCall(rootPath, target).args, '--force'],
    }
    await expect(
      dispatchWorkerHostCall(extra, project, { allowWorktreeAdd: target }),
    ).rejects.toThrow('forbidden git invocation')
    expect(exec).not.toHaveBeenCalled()
  })

  it('creates a real worktree at the owned location through GitEngine', async () => {
    const rootPath = await tempRoot()
    git(rootPath, ['init', '-b', 'main'])
    git(rootPath, ['config', 'user.email', 'hvir@example.test'])
    git(rootPath, ['config', 'user.name', 'hvir test'])
    git(rootPath, ['commit', '--allow-empty', '-m', 'base'])
    const head = execFileSync('git', ['-C', rootPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const host = new LocalHost()
    const root = localPath(rootPath)
    const target = hvirWorktreeTarget(root, 'review-1', head)
    const engine = new GitEngine(
      brokeredPort(host, root, { allowWorktreeAdd: target }),
      root,
    )

    const discovery = await engine.hvirWorktree(root, { operation: 'add', target })

    expect(discovery.worktrees.map((worktree) => worktree.root.path)).toContain(
      target.path,
    )
    expect(
      execFileSync('git', ['-C', target.path, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('hvir/architecture/review-1')
  })
})

function brokeredPort(
  host: LocalHost,
  root: ReturnType<typeof localPath>,
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
        { host, root },
        permissions,
      ) as Promise<ExecResult>,
    readTextFile: (path: ReturnType<typeof localPath>) => host.readTextFile(path),
    readTextFilePrefix: (path: ReturnType<typeof localPath>, maxBytes: number) =>
      host.readTextFilePrefix(path, maxBytes),
    stat: (path: ReturnType<typeof localPath>) => host.stat(path),
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}
