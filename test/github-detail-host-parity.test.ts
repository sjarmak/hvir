import { describe, expect, it, vi } from 'vitest'

import { GitHubService } from '../src/main/github/github-service'
import { parsePullDetailOutput } from '../src/main/github/github-parse'
import type { ExecOptions, ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type ExecResult, type HostPath } from '../src/shared'

function result(stdout: string, code = 0): ExecResult {
  return { code, signal: null, stdout, stderr: '' }
}

function detailOutput(repo: string, headOid: string): string {
  const [owner, name] = repo.split('/')
  return JSON.stringify({
    data: {
      repository: {
        nameWithOwner: `${owner}/${name}`,
        pullRequest: {
          number: 12,
          title: 'Panel',
          url: `https://github.com/${repo}/pull/12`,
          headRefOid: headOid,
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [],
          },
        },
      },
    },
  })
}

function hostFor(
  root: HostPath,
  headOid: string,
): {
  readonly host: ProjectHost
  readonly exec: ReturnType<typeof vi.fn<ProjectHost['exec']>>
} {
  const exec = vi.fn(
    (command: string, args: readonly string[], _options?: ExecOptions) => {
      if (command === 'gh' && args[0] === 'repo')
        return Promise.resolve(result('{"nameWithOwner":"acme/widgets"}'))
      if (command === 'gh')
        return Promise.resolve(result(detailOutput('acme/widgets', headOid)))
      return Promise.resolve(result(''))
    },
  )
  return {
    host: { hostId: root.hostId, exec } as unknown as ProjectHost,
    exec,
  }
}

describe('GitHub detail host parity', () => {
  it.each([
    hostPath(asHostId('local'), '/projects/widgets'),
    hostPath(asHostId('ssh-build'), '/srv/widgets'),
  ])('returns the same bounded detail on %s', async (root) => {
    const { host, exec } = hostFor(root, 'head-12')
    const github = new GitHubService({ getProject: () => ({ host, root }) })

    await expect(
      github.detail({ root, repo: 'acme/widgets', number: 12, headOid: 'head-12' }),
    ).resolves.toMatchObject({
      available: true,
      repo: 'acme/widgets',
      number: 12,
      headOid: 'head-12',
      threadsPageComplete: true,
      payloadTruncated: false,
    })
    const ghCall = exec.mock.calls.find(
      (call) => call[0] === 'gh' && call[1][0] === 'api',
    )
    expect(ghCall?.[2]).toMatchObject({ cwd: root, maxBuffer: 1024 * 1024 })
  })

  it('rejects a changed remote head on an SSH host', async () => {
    const root = hostPath(asHostId('ssh-build'), '/srv/widgets')
    const { host } = hostFor(root, 'new-head')
    const github = new GitHubService({ getProject: () => ({ host, root }) })

    await expect(
      github.detail({ root, repo: 'acme/widgets', number: 12, headOid: 'old-head' }),
    ).resolves.toMatchObject({
      available: false,
      reason: 'error',
      message: 'Pull request changed while loading details',
    })
  })

  it('rejects GraphQL errors without exposing arbitrary payloads', () => {
    expect(() =>
      parsePullDetailOutput(
        JSON.stringify({ errors: [{ message: 'permission denied' }] }),
        'acme/widgets',
        12,
      ),
    ).toThrow('GitHub GraphQL error: permission denied')
  })

  it('rejects mismatched pull identity', () => {
    expect(() =>
      parsePullDetailOutput(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 13,
                title: 'Panel',
                url: 'https://github.com/acme/widgets/pull/13',
              },
            },
          },
        }),
        'acme/widgets',
        12,
      ),
    ).toThrow('GitHub pull request detail identity did not match the request')
  })
})
