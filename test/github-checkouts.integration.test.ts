import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { GitHubService } from '../src/main/github/github-service'
import type { ExecOptions, ProjectHost } from '../src/main/project-host'
import { hostPath, LOCAL_HOST_ID, type ExecResult } from '../src/shared'

const run = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await run('git', args as string[], { cwd })
}

describe('GitHub checkout discovery with real git', () => {
  it('reports worktrees and exact upstream refs, including renamed locals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-github-checkouts-'))
    try {
      const panel = join(directory, 'panel')
      const forkPanel = join(directory, 'fork-panel')
      const gone = join(directory, 'gone')
      await git(directory, ['init', '-q'])
      await git(directory, ['config', 'user.email', 'test@example.com'])
      await git(directory, ['config', 'user.name', 'Test'])
      await writeFile(join(directory, 'README.md'), 'test\n')
      await git(directory, ['add', 'README.md'])
      await git(directory, ['commit', '-qm', 'initial'])
      await git(directory, ['branch', '-M', 'main'])
      await git(directory, ['remote', 'add', 'origin', 'https://github.com/acme/widgets'])
      await git(directory, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      await git(directory, ['branch', '--set-upstream-to=origin/main', 'main'])
      await git(directory, ['branch', 'local-name'])
      await git(directory, ['update-ref', 'refs/remotes/origin/feat/panel', 'HEAD'])
      await git(directory, [
        'branch',
        '--set-upstream-to=origin/feat/panel',
        'local-name',
      ])
      await git(directory, ['worktree', 'add', panel, 'local-name'])
      await writeFile(join(panel, 'unpushed.txt'), 'local\n')
      await git(panel, ['add', 'unpushed.txt'])
      await git(panel, ['commit', '-qm', 'unpushed'])
      await git(directory, [
        'remote',
        'add',
        'fork',
        'https://github.com/contributor/widgets',
      ])
      await git(directory, ['update-ref', 'refs/remotes/fork/feat/panel', 'HEAD'])
      await git(directory, ['branch', 'fork-local'])
      await git(directory, ['branch', '--set-upstream-to=fork/feat/panel', 'fork-local'])
      await git(directory, ['worktree', 'add', forkPanel, 'fork-local'])
      await git(directory, ['update-ref', 'refs/remotes/origin/feat/gone', 'HEAD'])
      await git(directory, ['branch', 'gone-local'])
      await git(directory, ['branch', '--set-upstream-to=origin/feat/gone', 'gone-local'])
      await git(directory, ['update-ref', '-d', 'refs/remotes/origin/feat/gone'])
      await git(directory, ['worktree', 'add', gone, 'gone-local'])

      const root = hostPath(LOCAL_HOST_ID, directory)
      const host = {
        hostId: LOCAL_HOST_ID,
        exec: async (
          command: string,
          args: readonly string[],
          options?: ExecOptions,
        ): Promise<ExecResult> => {
          try {
            const result = await run(command, args as string[], {
              cwd: options?.cwd?.path,
            })
            return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr }
          } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string }
            return {
              code: failure.code ?? 1,
              signal: null,
              stdout: failure.stdout ?? '',
              stderr: failure.stderr ?? '',
            }
          }
        },
      } as unknown as ProjectHost
      const response = await new GitHubService({
        getProject: () => ({ host, root }),
      }).checkouts({ root })

      expect(response).toEqual({
        available: true,
        checkouts: [
          { root, branch: 'main', headRepo: 'acme/widgets', headRef: 'main' },
          {
            root: hostPath(LOCAL_HOST_ID, forkPanel),
            branch: 'fork-local',
            headRepo: 'contributor/widgets',
            headRef: 'feat/panel',
          },
          {
            root: hostPath(LOCAL_HOST_ID, gone),
            branch: 'gone-local',
            headRepo: 'acme/widgets',
            headRef: 'feat/gone',
          },
          {
            root: hostPath(LOCAL_HOST_ID, panel),
            branch: 'local-name',
            headRepo: 'acme/widgets',
            headRef: 'feat/panel',
          },
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
