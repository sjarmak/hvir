import { describe, expect, it, vi } from 'vitest'

import { GitHubService } from '../src/main/github/github-service'
import { PULLS_QUERY, pullsQueryArgs } from '../src/main/github/github-query'
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
