import { describe, expect, it, vi } from 'vitest'

import { GitHubService } from '../src/main/github/github-service'
import { PULLS_QUERY, pullsQueryArgs } from '../src/main/github/github-query'
import { parsePullDetailOutput } from '../src/main/github/github-parse'
import type { ExecOptions, ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type ExecResult } from '../src/shared'

const ROOT = hostPath(asHostId('local'), '/projects/widgets')

function execResult(code: number, stdout: string, stderr = ''): ExecResult {
  return { code, signal: null, stdout, stderr }
}

type Responder = (command: string, args: readonly string[]) => ExecResult

const PULLS_OUTPUT = JSON.stringify({
  data: {
    viewer: { login: 'stephanie' },
    repository: {
      branch: {
        nodes: [
          {
            number: 12,
            title: 'Panel',
            url: 'https://github.com/acme/widgets/pull/12',
            state: 'OPEN',
            isDraft: false,
            headRefName: 'feat/panel',
            updatedAt: '2026-09-30T00:00:00Z',
            reviewDecision: 'APPROVED',
            author: { login: 'stephanie' },
            headRepository: { nameWithOwner: 'acme/widgets' },
            commits: { nodes: [] },
            reviewThreads: { nodes: [] },
            reviews: { nodes: [] },
            comments: { nodes: [] },
          },
        ],
      },
    },
    mine: { nodes: [] },
    review: { nodes: [] },
  },
})

const defaultResponder: Responder = (command, args) => {
  if (command === 'git' && args[0] === 'remote') {
    return execResult(0, 'origin\thttps://github.com/acme/widgets (fetch)\n')
  }
  if (command === 'git') return execResult(0, 'feat/panel\n')
  if (args[0] === 'repo') return execResult(0, '{"nameWithOwner":"acme/widgets"}')
  return execResult(0, PULLS_OUTPUT)
}

function fakeHost(respond: Responder = defaultResponder) {
  const exec = vi.fn((command: string, args: readonly string[], _options?: ExecOptions) =>
    Promise.resolve(respond(command, args)),
  )
  const host = { hostId: ROOT.hostId, exec } as unknown as ProjectHost
  return { host, exec }
}

function service(host: ProjectHost, now: () => number = () => 0): GitHubService {
  return new GitHubService({ getProject: () => ({ host, root: ROOT }), now })
}

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

describe('GitHubService.pulls', () => {
  it('returns the snapshot for the current branch and repo', async () => {
    const { host, exec } = fakeHost()
    const snapshot = await service(host).pulls({ root: ROOT })
    expect(snapshot).toMatchObject({
      available: true,
      repo: 'acme/widgets',
      viewer: 'stephanie',
      branch: 'feat/panel',
      branchPulls: [{ number: 12, review: 'approved', checks: 'none' }],
    })
    const graphql = exec.mock.calls.find((call) => call[1][1] === 'graphql')
    expect(graphql?.[1]).toEqual(pullsQueryArgs('acme/widgets', 'feat/panel'))
    expect(graphql?.[2]).toMatchObject({
      cwd: ROOT,
      loginShell: true,
      lane: 'background',
    })
    expect(graphql?.[2]?.timeout).toBeGreaterThan(0)
  })

  it('omits pull requests whose head is the repository default branch', async () => {
    const { host } = fakeHost((command, args) => {
      if (command === 'git' && args[0] === 'symbolic-ref') {
        return execResult(0, 'main\n')
      }
      if (command !== 'gh' || args[1] !== 'graphql') {
        return defaultResponder(command, args)
      }
      return execResult(
        0,
        JSON.stringify({
          data: {
            viewer: { login: 'stephanie' },
            repository: {
              defaultBranchRef: { name: 'main' },
              branch: {
                nodes: [
                  {
                    number: 12,
                    title: 'Old main pull request',
                    url: 'https://github.com/acme/widgets/pull/12',
                    state: 'CLOSED',
                    headRefName: 'main',
                    headRepository: { nameWithOwner: 'acme/widgets' },
                  },
                ],
              },
            },
            mine: { nodes: [] },
            review: { nodes: [] },
          },
        }),
      )
    })
    await expect(service(host).pulls({ root: ROOT })).resolves.toMatchObject({
      available: true,
      branch: 'main',
      branchPulls: [],
    })
  })

  it('reuses the resolved repo until it goes stale', async () => {
    let now = 0
    const { host, exec } = fakeHost()
    const github = service(host, () => now)
    await github.pulls({ root: ROOT })
    await github.pulls({ root: ROOT })
    now = 11 * 60_000
    await github.pulls({ root: ROOT })
    const repoViews = exec.mock.calls.filter((call) => call[1][0] === 'repo')
    expect(repoViews).toHaveLength(2)
  })

  it('skips the branch query on a detached head', async () => {
    const { host, exec } = fakeHost((command, args) =>
      command === 'git' && args[0] === 'symbolic-ref'
        ? execResult(1, '')
        : defaultResponder(command, args),
    )
    const snapshot = await service(host).pulls({ root: ROOT })
    expect(snapshot).toMatchObject({ available: true })
    expect(snapshot).not.toHaveProperty('branch')
    const graphql = exec.mock.calls.find((call) => call[1][1] === 'graphql')
    expect(graphql?.[1]).toContain('hasBranch=false')
  })

  it('reports gh missing when the binary cannot be spawned', async () => {
    const spy = quiet()
    const { host } = fakeHost(() => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    })
    const snapshot = await service(host).pulls({ root: ROOT })
    expect(snapshot).toMatchObject({ available: false, reason: 'gh-missing' })
    expect(spy).toHaveBeenCalled()
  })

  it('does not blame gh for an unrelated spawn failure', async () => {
    quiet()
    const { host } = fakeHost(() => {
      throw new Error('host not found')
    })
    const snapshot = await service(host).pulls({ root: ROOT })
    expect(snapshot).toMatchObject({ available: false, reason: 'error' })
    expect(snapshot.available === false && snapshot.message).toMatch(/host not found/)
  })

  it('drops a same-named branch pull from a repo with no local remote', async () => {
    quiet()
    const { host } = fakeHost((command, args) =>
      command === 'git' && args[0] === 'remote'
        ? execResult(0, 'origin\thttps://github.com/someone/else (fetch)\n')
        : defaultResponder(command, args),
    )
    expect(await service(host).pulls({ root: ROOT })).toMatchObject({
      available: true,
      branchPulls: [],
    })
  })

  it('skips gh entirely when the workspace has no GitHub remote', async () => {
    const { host, exec } = fakeHost((command, args) =>
      command === 'git' && args[0] === 'remote'
        ? execResult(0, '')
        : defaultResponder(command, args),
    )
    expect(await service(host).pulls({ root: ROOT })).toMatchObject({
      available: false,
      reason: 'no-github-repo',
    })
    expect(exec.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ['git', 'remote'],
    ])
  })

  it('runs every read on the lane the caller asks for', async () => {
    const { host, exec } = fakeHost()
    const snapshot = await service(host).pullsForProject(
      { root: ROOT },
      { host, root: ROOT },
      'interactive',
    )
    expect(snapshot.available).toBe(true)
    expect(exec.mock.calls.length).toBeGreaterThan(0)
    expect(exec.mock.calls.every((call) => call[2]?.lane === 'interactive')).toBe(true)
  })

  it('reports gh missing when the login shell cannot find it', async () => {
    const { host } = fakeHost((command, args) =>
      command === 'gh'
        ? execResult(127, '', 'gh: command not found')
        : defaultResponder(command, args),
    )
    expect(await service(host).pulls({ root: ROOT })).toMatchObject({
      reason: 'gh-missing',
    })
  })

  it('classifies an unauthenticated gh', async () => {
    const spy = quiet()
    const { host } = fakeHost((command, args) =>
      command === 'gh'
        ? execResult(4, '', 'run: gh auth login')
        : defaultResponder(command, args),
    )
    expect(await service(host).pulls({ root: ROOT })).toMatchObject({
      available: false,
      reason: 'gh-unauthenticated',
    })
    expect(spy).toHaveBeenCalled()
  })

  it('identifies unauthenticated gh output from a remote execution host', async () => {
    const spy = quiet()
    const remoteRoot = hostPath(asHostId('ssh-mac'), '/projects/widgets')
    const exec = vi.fn((command: string, args: readonly string[]) =>
      Promise.resolve(
        command === 'gh'
          ? execResult(4, '', 'The token in default is invalid')
          : defaultResponder(command, args),
      ),
    )
    const host = { hostId: remoteRoot.hostId, exec } as unknown as ProjectHost
    const github = new GitHubService({
      getProject: () => ({ host, root: remoteRoot }),
    })

    await expect(github.pulls({ root: remoteRoot })).resolves.toMatchObject({
      available: false,
      reason: 'gh-remote-unauthenticated',
    })
    expect(spy).toHaveBeenCalled()
  })

  it('does not cache a failed repo lookup', async () => {
    quiet()
    let fail = true
    const { host, exec } = fakeHost((command, args) =>
      args[0] === 'repo' && fail
        ? execResult(1, '', 'boom')
        : defaultResponder(command, args),
    )
    const github = service(host)
    expect((await github.pulls({ root: ROOT })).available).toBe(false)
    fail = false
    expect((await github.pulls({ root: ROOT })).available).toBe(true)
    expect(exec.mock.calls.filter((call) => call[1][0] === 'repo')).toHaveLength(2)
  })

  it('turns malformed GraphQL output into an error state', async () => {
    const { host } = fakeHost((command, args) =>
      args[1] === 'graphql'
        ? execResult(0, '{"errors":[{"message":"bad"}]}')
        : defaultResponder(command, args),
    )
    const response = await service(host).pulls({ root: ROOT })
    expect(response).toMatchObject({ available: false, reason: 'error' })
    expect(response.available === false && response.message).toMatch(/bad/)
  })

  it('refuses a root other than the active workspace', async () => {
    const { host, exec } = fakeHost()
    await expect(
      service(host).pulls({ root: hostPath(asHostId('local'), '/elsewhere') }),
    ).rejects.toThrow(/active workspace/)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('GitHubService.probe', () => {
  it('detects a github.com remote', async () => {
    const { host } = fakeHost()
    expect(await service(host).probe(ROOT)).toEqual({ hasGitHubRemote: true })
  })

  it('says no for other remotes, git failures, and a thrown exec', async () => {
    quiet()
    const other = fakeHost(() =>
      execResult(0, 'origin\thttps://gitlab.com/a/b (fetch)\n'),
    )
    expect(await service(other.host).probe(ROOT)).toEqual({ hasGitHubRemote: false })
    const failing = fakeHost(() => execResult(128, '', 'not a git repository'))
    expect(await service(failing.host).probe(ROOT)).toEqual({ hasGitHubRemote: false })
    const thrown = fakeHost(() => {
      throw new Error('disconnected')
    })
    expect(await service(thrown.host).probe(ROOT)).toEqual({ hasGitHubRemote: false })
  })
})

describe('GitHubService.checkouts', () => {
  it('returns live nonbare worktrees with verified upstream identity', async () => {
    const { host } = fakeHost((command, args) => {
      if (command !== 'git') return defaultResponder(command, args)
      if (args[0] === 'worktree') {
        return execResult(
          0,
          `worktree ${ROOT.path}\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0` +
            `worktree /projects/panel\0HEAD ${'b'.repeat(40)}\0branch refs/heads/feat/panel\0\0` +
            'worktree /projects/stale\0prunable stale\0branch refs/heads/stale\0\0' +
            'worktree /projects/bare\0bare\0\0',
        )
      }
      if (args[0] === 'for-each-ref') {
        return execResult(
          0,
          'main\0origin\0refs/heads/main\0\n' +
            'feat/panel\0origin\0refs/heads/feat/panel\0\n' +
            'stale\0origin\0refs/heads/stale\0\n',
        )
      }
      if (args[0] === 'remote') {
        return execResult(0, 'origin\thttps://github.com/acme/widgets (fetch)\n')
      }
      return defaultResponder(command, args)
    })
    expect(await service(host).checkouts({ root: ROOT })).toEqual({
      available: true,
      checkouts: [
        { root: ROOT, branch: 'main', headRepo: 'acme/widgets', headRef: 'main' },
        {
          root: hostPath(asHostId('local'), '/projects/panel'),
          branch: 'feat/panel',
          headRepo: 'acme/widgets',
          headRef: 'feat/panel',
        },
      ],
    })
  })

  it('fails closed when git checkout reads fail and rejects inactive roots', async () => {
    const failing = fakeHost((command) =>
      command === 'git'
        ? execResult(128, '', 'not a repository')
        : defaultResponder(command, []),
    )
    expect(await service(failing.host).checkouts({ root: ROOT })).toMatchObject({
      available: false,
      message: 'not a repository',
    })
    await expect(
      service(failing.host).checkouts({
        root: hostPath(asHostId('local'), '/elsewhere'),
      }),
    ).rejects.toThrow(/active workspace/)
  })

  it('returns spawned host errors and preserves host-qualified checkout roots', async () => {
    const remoteRoot = hostPath(asHostId('ssh-1'), '/srv/widgets')
    const exec = vi.fn((command: string, args: readonly string[]) => {
      if (command !== 'git') throw new Error('host disconnected')
      if (args[0] === 'worktree') {
        return execResult(0, 'worktree /srv/widgets\0branch refs/heads/main\0\0')
      }
      if (args[0] === 'for-each-ref') {
        return execResult(0, 'main\0origin\0refs/heads/main\0\n')
      }
      return execResult(0, 'origin\thttps://github.com/acme/widgets (fetch)\n')
    })
    const host = { hostId: remoteRoot.hostId, exec } as unknown as ProjectHost
    const response = await new GitHubService({
      getProject: () => ({ host, root: remoteRoot }),
    }).checkouts({ root: remoteRoot })
    expect(response).toMatchObject({ available: true })
    expect(response.available && response.checkouts[0]?.root).toEqual(remoteRoot)

    const failing = fakeHost(() => {
      throw new Error('spawn failed')
    })
    expect(await service(failing.host).checkouts({ root: ROOT })).toEqual({
      available: false,
      message: 'spawn failed',
    })
  })

  it('bounds every checkout read and rejects a root that changes while reading', async () => {
    const { host, exec } = fakeHost()
    const github = new GitHubService({
      getProject: () => ({ host, root: ROOT }),
    })
    await github.checkouts({ root: ROOT })
    expect(exec.mock.calls.every((call) => call[2]?.maxBuffer !== undefined)).toBe(true)

    let current = ROOT
    const changing = fakeHost()
    const guarded = new GitHubService({
      getProject: () => ({ host: changing.host, root: current }),
    })
    changing.exec.mockImplementation((...args) => {
      current = hostPath(asHostId('local'), '/elsewhere')
      return Promise.resolve(defaultResponder(args[0], args[1]))
    })
    await expect(guarded.checkouts({ root: ROOT })).rejects.toThrow(/active workspace/)
  })
})

describe('pullsQueryArgs', () => {
  it('passes every value as a raw string field except the boolean', () => {
    const args = pullsQueryArgs('acme/widgets', '@feat')
    expect(args).toContain(`query=${PULLS_QUERY}`)
    expect(args).toContain('branch=@feat')
    const flagFor = (value: string) => args[args.indexOf(value) - 1]
    expect(flagFor('branch=@feat')).toBe('-f')
    expect(flagFor('hasBranch=true')).toBe('-F')
    expect(args).toContain('mine=repo:acme/widgets is:pr is:open author:@me')
  })
})

describe('GitHubService.detail', () => {
  it('reads bounded selected feedback and preserves reviewed identity', async () => {
    const detailOutput = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 12,
            title: 'Panel',
            url: 'https://github.com/acme/widgets/pull/12',
            headRefOid: 'head-12',
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  isOutdated: true,
                  path: 'src/panel.ts',
                  line: 8,
                  comments: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        id: 'comment-1',
                        body: 'Please revisit this',
                        author: { login: 'reviewer' },
                        commit: { oid: 'head-12' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    })
    const { host, exec } = fakeHost((command, args) =>
      command === 'gh' && args[1] === 'graphql'
        ? execResult(0, detailOutput)
        : defaultResponder(command, args),
    )
    const response = await service(host).detail({
      root: ROOT,
      repo: 'acme/widgets',
      number: 12,
      headOid: 'head-12',
    })
    expect(response).toMatchObject({
      available: true,
      repo: 'acme/widgets',
      headOid: 'head-12',
      threads: [{ id: 'thread-1', isOutdated: true, reviewedCommitOid: 'head-12' }],
      payloadTruncated: false,
    })
    const graphql = exec.mock.calls.find(
      (call) => call[0] === 'gh' && call[1][1] === 'graphql',
    )
    expect(graphql?.[2]?.maxBuffer).toBe(1024 * 1024)
  })

  it('only discloses incomplete replies when page metadata says they are incomplete', () => {
    const comments = Array.from({ length: 20 }, (_, index) => ({
      id: `comment-${index}`,
      body: 'feedback',
    }))
    const output = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 12,
            title: 'Panel',
            url: 'https://github.com/acme/widgets/pull/12',
            headRefOid: 'head-12',
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'thread-1',
                  comments: { pageInfo: { hasNextPage: false }, nodes: comments },
                },
              ],
            },
          },
        },
      },
    })
    const complete = parsePullDetailOutput(output, 'acme/widgets', 12)
    expect(complete.payloadTruncated).toBe(false)
    const incomplete = parsePullDetailOutput(
      output.replace(/("comments":\{"pageInfo":\{"hasNextPage":)false/, '$1true'),
      'acme/widgets',
      12,
    )
    expect(incomplete.payloadTruncated).toBe(true)
    const missingPageInfo = parsePullDetailOutput(
      output.replace(
        '"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes"',
        '"reviewThreads":{"nodes"',
      ),
      'acme/widgets',
      12,
    )
    expect(missingPageInfo.payloadTruncated).toBe(true)
  })

  it('fails closed when the requested head identity is unknown or stale', async () => {
    const { host } = fakeHost()
    await expect(
      service(host).detail({ root: ROOT, repo: 'acme/widgets', number: 12 }),
    ).resolves.toMatchObject({ available: false, reason: 'error' })
    await expect(
      service(host).detail({
        root: ROOT,
        repo: 'acme/widgets',
        number: 12,
        headOid: 'stale',
      }),
    ).resolves.toMatchObject({ available: false, reason: 'error' })
  })

  it('fails closed when the active repository changes during the detail read', async () => {
    let repoReads = 0
    const { host } = fakeHost((command, args) => {
      if (command === 'gh' && args[0] === 'repo') {
        repoReads += 1
        return execResult(
          0,
          JSON.stringify({
            nameWithOwner: repoReads === 1 ? 'acme/widgets' : 'acme/other',
          }),
        )
      }
      if (command === 'gh') {
        return execResult(
          0,
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 12,
                  title: 'Panel',
                  url: 'https://github.com/acme/widgets/pull/12',
                  headRefOid: 'head-12',
                  reviewThreads: {
                    pageInfo: { hasNextPage: false },
                    nodes: [],
                  },
                },
              },
            },
          }),
        )
      }
      return defaultResponder(command, args)
    })
    await expect(
      service(host).detail({
        root: ROOT,
        repo: 'acme/widgets',
        number: 12,
        headOid: 'head-12',
      }),
    ).resolves.toMatchObject({
      available: false,
      message: 'GitHub repository changed while loading details',
    })
  })
})

describe('GitHubService.pullWorktreeSource', () => {
  function headResponder(
    head: string,
    remotes = 'origin\thttps://github.com/acme/widgets (fetch)\n',
  ): Responder {
    return (command, args) => {
      if (command === 'git' && args[0] === 'remote') return execResult(0, remotes)
      if (args[0] === 'repo') return execResult(0, '{"nameWithOwner":"acme/widgets"}')
      if (args[0] === 'pr') return execResult(0, head)
      return execResult(1, '', 'unexpected')
    }
  }
  const sameRepo =
    '{"number":12,"state":"OPEN","headRefName":"feat/panel","isCrossRepository":false}'

  it('resolves the head branch and the remote for an open same-repository PR', async () => {
    const { host, exec } = fakeHost(headResponder(sameRepo))
    await expect(service(host).pullWorktreeSource(ROOT, 12)).resolves.toEqual({
      number: 12,
      branch: 'feat/panel',
      remote: 'origin',
    })
    const view = exec.mock.calls.find((call) => call[1][0] === 'pr')
    expect(view?.[1]).toEqual([
      'pr',
      'view',
      '12',
      '--repo',
      'acme/widgets',
      '--json',
      'number,state,headRefName,isCrossRepository',
    ])
  })

  it.each([
    [
      'a fork',
      '{"number":12,"state":"OPEN","headRefName":"feat/panel","isCrossRepository":true}',
      'comes from a fork',
    ],
    [
      'a closed PR',
      '{"number":12,"state":"CLOSED","headRefName":"feat/panel","isCrossRepository":false}',
      'no longer open',
    ],
  ])('refuses %s', async (_label, head, message) => {
    const { host } = fakeHost(headResponder(head))
    await expect(service(host).pullWorktreeSource(ROOT, 12)).rejects.toThrow(message)
  })

  it('refuses when no remote points at the repository, or the number is invalid', async () => {
    const { host } = fakeHost(
      headResponder(sameRepo, 'origin\thttps://github.com/me/widgets (fetch)\n'),
    )
    await expect(service(host).pullWorktreeSource(ROOT, 12)).rejects.toThrow(
      'No git remote',
    )
    await expect(service(host).pullWorktreeSource(ROOT, 0)).rejects.toThrow(
      'Invalid pull request number',
    )
    await expect(
      service(host).pullWorktreeSource(hostPath(ROOT.hostId, '/elsewhere'), 12),
    ).rejects.toThrow('active workspace root')
  })
})
