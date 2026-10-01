import {
  hostPathEquals,
  isHostPathShape,
  type HostPath,
  type PullsProbeResponse,
  type PullsRequest,
  type PullsResponse,
  type PullsUnavailable,
} from '../../shared'
import type { ExecOptions, ProjectHost } from '../project-host'
import {
  classifyGhFailure,
  githubRemoteRepos,
  parsePullsOutput,
  parseRepoView,
} from './github-parse'
import { pullsQueryArgs } from './github-query'

const GH_TIMEOUT_MS = 20_000
const GIT_TIMEOUT_MS = 5_000
const REPO_TTL_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const GH_MISSING: GhResult = {
  ok: false,
  unavailable: {
    available: false,
    reason: 'gh-missing',
    message: 'The gh CLI is not installed on this host.',
  },
}

export interface GitHubServiceDeps {
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
  readonly now?: () => number
}

type GhResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly unavailable: PullsUnavailable }

type RepoResult =
  | { readonly ok: true; readonly repo: string }
  | { readonly ok: false; readonly unavailable: PullsUnavailable }

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export class GitHubService {
  private readonly repos = new Map<
    string,
    { readonly repo: string; readonly at: number }
  >()
  private readonly now: () => number

  constructor(private readonly deps: GitHubServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  async probe(requestedRoot: HostPath): Promise<PullsProbeResponse> {
    const { host, root } = this.activeProject(requestedRoot)
    return { hasGitHubRemote: (await this.remoteRepos(host, root)).size > 0 }
  }

  async pulls(req: PullsRequest): Promise<PullsResponse> {
    const { host, root } = this.activeProject(req.root)
    const repo = await this.resolveRepo(host, root)
    if (!repo.ok) return repo.unavailable
    const [branch, localRepos] = await Promise.all([
      this.currentBranch(host, root),
      this.remoteRepos(host, root),
    ])
    const result = await this.gh(host, root, pullsQueryArgs(repo.repo, branch))
    if (!result.ok) return result.unavailable
    try {
      const parsed = parsePullsOutput(result.stdout, localRepos)
      return {
        available: true,
        repo: repo.repo,
        viewer: parsed.viewer,
        ...(branch === undefined ? {} : { branch }),
        branchPulls: parsed.branchPulls,
        authored: parsed.authored,
        reviewRequested: parsed.reviewRequested,
      }
    } catch (reason) {
      return { available: false, reason: 'error', message: errorMessage(reason) }
    }
  }

  private activeProject(requested: HostPath): {
    readonly host: ProjectHost
    readonly root: HostPath
  } {
    const project = this.deps.getProject()
    if (!isHostPathShape(requested) || !hostPathEquals(requested, project.root)) {
      throw new Error('GitHub requests are limited to the active workspace root')
    }
    return project
  }

  private async resolveRepo(host: ProjectHost, root: HostPath): Promise<RepoResult> {
    const key = `${root.hostId}\u0000${root.path}`
    const cached = this.repos.get(key)
    if (cached !== undefined && this.now() - cached.at < REPO_TTL_MS) {
      return { ok: true, repo: cached.repo }
    }
    const result = await this.gh(host, root, ['repo', 'view', '--json', 'nameWithOwner'])
    if (!result.ok) return result
    try {
      const repo = parseRepoView(result.stdout)
      this.repos.set(key, { repo, at: this.now() })
      return { ok: true, repo }
    } catch (reason) {
      return {
        ok: false,
        unavailable: {
          available: false,
          reason: 'no-github-repo',
          message: errorMessage(reason),
        },
      }
    }
  }

  private async remoteRepos(
    host: ProjectHost,
    root: HostPath,
  ): Promise<ReadonlySet<string>> {
    try {
      const result = await host.exec('git', ['remote', '-v'], this.gitOptions(root))
      if (result.code !== 0) {
        console.error('[github] git remote exited non-zero', result.stderr.trim())
        return new Set()
      }
      return githubRemoteRepos(result.stdout)
    } catch (reason) {
      console.error('[github] remote lookup failed', errorMessage(reason))
      return new Set()
    }
  }

  private async currentBranch(
    host: ProjectHost,
    root: HostPath,
  ): Promise<string | undefined> {
    try {
      const result = await host.exec(
        'git',
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        this.gitOptions(root),
      )
      const branch = result.stdout.trim()
      return result.code === 0 && branch !== '' ? branch : undefined
    } catch (reason) {
      console.error('[github] branch lookup failed', errorMessage(reason))
      return undefined
    }
  }

  private async gh(
    host: ProjectHost,
    root: HostPath,
    args: readonly string[],
  ): Promise<GhResult> {
    let result
    try {
      result = await host.exec('gh', args, {
        cwd: root,
        loginShell: true,
        lane: 'background',
        timeout: GH_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      })
    } catch (reason) {
      const message = errorMessage(reason)
      console.error('[github] gh failed to run', { args: args.slice(0, 2), message })
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return GH_MISSING
      return { ok: false, unavailable: { available: false, reason: 'error', message } }
    }
    if (result.code === 127) return GH_MISSING
    if (result.code !== 0) {
      console.error('[github] gh exited non-zero', {
        args: args.slice(0, 2),
        code: result.code,
        stderr: result.stderr.trim(),
      })
      return { ok: false, unavailable: classifyGhFailure(result.stderr) }
    }
    return { ok: true, stdout: result.stdout }
  }

  private gitOptions(root: HostPath): ExecOptions {
    return { cwd: root, lane: 'background', timeout: GIT_TIMEOUT_MS }
  }
}
