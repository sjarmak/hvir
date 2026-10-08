import {
  hostPathEquals,
  isHostPathShape,
  LOCAL_HOST_ID,
  PULLS_MAX_LIMIT,
  PULLS_PAGE_SIZE,
  type HostPath,
  type PullsProbeResponse,
  type PullsRequest,
  type PullsResponse,
  type PullDetailRequest,
  type PullDetailResponse,
  type PullsUnavailable,
  type PullCheckoutsRequest,
  type PullCheckoutsResponse,
  type PullCheckout,
  type ExecResult,
} from '../../shared'
import type { ExecLane, ExecOptions, ProjectHost } from '../project-host'
import {
  classifyGhFailure,
  githubRemoteRepos,
  parsePullsOutput,
  parseRepoView,
  parseBranchUpstreams,
  githubRemoteRepositoryMap,
  parsePullDetailOutput,
  parsePullHead,
  githubRemoteFor,
} from './github-parse'
import type { PullWorktreeSource } from '../git/pull-worktrees'
import { parseWorktreeList } from '../git/git-parsers'
import { pullDetailQueryArgs, pullsQueryArgs } from './github-query'

const GH_TIMEOUT_MS = 20_000
const GIT_TIMEOUT_MS = 20_000
const REPO_TTL_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DETAIL_MAX_OUTPUT_BYTES = 1024 * 1024
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

function pullsLimit(requested: unknown): number {
  return typeof requested === 'number' &&
    Number.isInteger(requested) &&
    requested >= 1 &&
    requested <= PULLS_MAX_LIMIT
    ? requested
    : PULLS_PAGE_SIZE
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export class GitHubService {
  private readonly repos = new Map<
    string,
    { readonly repo: string; readonly at: number }
  >()
  private readonly now: () => number
  private readonly details = new Map<string, Promise<PullDetailResponse>>()

  constructor(private readonly deps: GitHubServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  async probe(requestedRoot: HostPath): Promise<PullsProbeResponse> {
    const { host, root } = this.activeProject(requestedRoot)
    return { hasGitHubRemote: ((await this.remoteRepos(host, root))?.size ?? 0) > 0 }
  }

  async pulls(req: PullsRequest): Promise<PullsResponse> {
    return this.pullsForProject(req, this.activeProject(req.root))
  }

  async detail(req: PullDetailRequest): Promise<PullDetailResponse> {
    const project = this.activeProject(req.root)
    if (
      !Number.isInteger(req.number) ||
      req.number < 1 ||
      typeof req.repo !== 'string' ||
      req.repo.trim() === ''
    ) {
      return {
        available: false,
        reason: 'error',
        message: 'Invalid pull request identity',
      }
    }
    if (typeof req.headOid !== 'string' || req.headOid.trim() === '') {
      return {
        available: false,
        reason: 'error',
        message: 'Pull request head identity is unknown',
      }
    }
    const key = `${project.root.hostId}\u0000${project.root.path}\u0000${req.repo.toLowerCase()}\u0000${req.number}\u0000${req.headOid}`
    const existing = this.details.get(key)
    if (existing !== undefined) return existing
    const pending = this.readDetail(req, project)
    this.details.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.details.get(key) === pending) this.details.delete(key)
    }
  }

  private async readDetail(
    req: PullDetailRequest,
    project: { readonly host: ProjectHost; readonly root: HostPath },
  ): Promise<PullDetailResponse> {
    const { host, root } = project
    const resolved = await this.resolveRepo(host, root)
    if (!resolved.ok) return resolved.unavailable
    if (resolved.repo.toLowerCase() !== req.repo.toLowerCase()) {
      return {
        available: false,
        reason: 'error',
        message: 'Pull request repository is not active',
      }
    }
    const result = await this.gh(
      host,
      root,
      pullDetailQueryArgs(resolved.repo, req.number),
      DETAIL_MAX_OUTPUT_BYTES,
    )
    if (!result.ok) return result.unavailable
    this.activeProject(req.root)
    const current = await this.resolveRepo(host, root, true)
    if (!current.ok) return current.unavailable
    this.activeProject(req.root)
    if (current.repo.toLowerCase() !== resolved.repo.toLowerCase()) {
      return {
        available: false,
        reason: 'error',
        message: 'GitHub repository changed while loading details',
      }
    }
    try {
      const detail = parsePullDetailOutput(result.stdout, current.repo, req.number)
      if (detail.headOid === undefined || detail.headOid !== req.headOid) {
        return {
          available: false,
          reason: 'error',
          message: 'Pull request changed while loading details',
        }
      }
      return detail
    } catch (reason) {
      return { available: false, reason: 'error', message: errorMessage(reason) }
    }
  }

  async pullsForProject(
    req: PullsRequest,
    project: { readonly host: ProjectHost; readonly root: HostPath },
    lane: ExecLane = 'background',
  ): Promise<PullsResponse> {
    const { host, root } = project
    const localRepos = await this.remoteRepos(host, root, lane)
    if (localRepos !== undefined && localRepos.size === 0) {
      return {
        available: false,
        reason: 'no-github-repo',
        message: 'No GitHub remote is configured for this workspace',
      }
    }
    const [branch, repo] = await Promise.all([
      this.currentBranch(host, root, lane),
      this.resolveRepo(host, root, false, lane),
    ])
    if (!repo.ok) return repo.unavailable
    const result = await this.gh(
      host,
      root,
      pullsQueryArgs(repo.repo, branch, pullsLimit(req.limit)),
      MAX_OUTPUT_BYTES,
      lane,
    )
    if (!result.ok) return result.unavailable
    try {
      const parsed = parsePullsOutput(result.stdout, localRepos ?? new Set(), branch)
      return {
        available: true,
        repo: repo.repo,
        viewer: parsed.viewer,
        ...(branch === undefined ? {} : { branch }),
        branchPulls: parsed.branchPulls,
        authored: parsed.authored,
        reviewRequested: parsed.reviewRequested,
        hasMore: parsed.hasMore,
      }
    } catch (reason) {
      return { available: false, reason: 'error', message: errorMessage(reason) }
    }
  }

  async checkouts(req: PullCheckoutsRequest): Promise<PullCheckoutsResponse> {
    const { host, root } = this.activeProject(req.root)
    const options = this.gitOptions(root)
    let worktrees: ExecResult
    let refs: ExecResult
    let remotes: ExecResult
    try {
      ;[worktrees, refs, remotes] = await Promise.all([
        host.exec('git', ['worktree', 'list', '--porcelain', '-z'], options),
        host.exec(
          'git',
          [
            'for-each-ref',
            '--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00',
            'refs/heads',
          ],
          options,
        ),
        host.exec('git', ['remote', '-v'], options),
      ])
    } catch (reason) {
      this.activeProject(req.root)
      return this.checkoutsError(errorMessage(reason))
    }
    this.activeProject(req.root)
    if (worktrees.code !== 0) return this.checkoutsError(worktrees.stderr)
    if (refs.code !== 0) return this.checkoutsError(refs.stderr)
    if (remotes.code !== 0) return this.checkoutsError(remotes.stderr)
    try {
      const upstreams = parseBranchUpstreams(
        refs.stdout,
        githubRemoteRepositoryMap(remotes.stdout),
      )
      const discovered = parseWorktreeList(worktrees.stdout, root.hostId)
      const checkouts: PullCheckout[] = discovered.flatMap((worktree) => {
        if (worktree.bare || worktree.prunable) return []
        const tracking =
          worktree.branch === undefined ? undefined : upstreams.get(worktree.branch)
        return [
          {
            root: worktree.root,
            ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
            ...(tracking?.headRepo === undefined || tracking.headRef === undefined
              ? {}
              : { headRepo: tracking.headRepo, headRef: tracking.headRef }),
          },
        ]
      })
      return { available: true, checkouts }
    } catch (reason) {
      return this.checkoutsError(errorMessage(reason))
    }
  }

  async pullWorktreeSource(
    requestedRoot: HostPath,
    number: number,
  ): Promise<PullWorktreeSource> {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error('Invalid pull request number')
    }
    const { host, root } = this.activeProject(requestedRoot)
    const repo = await this.resolveRepo(host, root, false, 'interactive')
    if (!repo.ok) throw new Error(repo.unavailable.message)
    const [view, remotes] = await Promise.all([
      this.gh(
        host,
        root,
        [
          'pr',
          'view',
          String(number),
          '--repo',
          repo.repo,
          '--json',
          'number,state,headRefName,isCrossRepository',
        ],
        DETAIL_MAX_OUTPUT_BYTES,
        'interactive',
      ),
      host.exec('git', ['remote', '-v'], this.gitOptions(root, 'interactive')),
    ])
    this.activeProject(requestedRoot)
    if (!view.ok) throw new Error(view.unavailable.message)
    if (remotes.code !== 0) {
      throw new Error(remotes.stderr.trim() || 'Git remote lookup failed')
    }
    const head = parsePullHead(view.stdout, number)
    if (!head.open) throw new Error(`PR #${number} is no longer open`)
    if (head.crossRepository) {
      throw new Error(
        `PR #${number} comes from a fork; hvir only creates worktrees for branches in ${repo.repo}`,
      )
    }
    const remote = githubRemoteFor(remotes.stdout, repo.repo)
    if (remote === undefined) {
      throw new Error(`No git remote in this checkout points at ${repo.repo}`)
    }
    return { number, branch: head.headRef, remote }
  }

  private checkoutsError(message: string): PullCheckoutsResponse {
    return {
      available: false,
      message: message.trim() || 'Git checkout discovery failed',
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

  private async resolveRepo(
    host: ProjectHost,
    root: HostPath,
    refresh = false,
    lane: ExecLane = 'background',
  ): Promise<RepoResult> {
    const key = `${root.hostId}\u0000${root.path}`
    const cached = this.repos.get(key)
    if (!refresh && cached !== undefined && this.now() - cached.at < REPO_TTL_MS) {
      return { ok: true, repo: cached.repo }
    }
    const result = await this.gh(
      host,
      root,
      ['repo', 'view', '--json', 'nameWithOwner'],
      MAX_OUTPUT_BYTES,
      lane,
    )
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
    lane: ExecLane = 'background',
  ): Promise<ReadonlySet<string> | undefined> {
    try {
      const result = await host.exec('git', ['remote', '-v'], this.gitOptions(root, lane))
      if (result.code !== 0) {
        console.error('[github] git remote exited non-zero', result.stderr.trim())
        return undefined
      }
      return githubRemoteRepos(result.stdout)
    } catch (reason) {
      console.error('[github] remote lookup failed', errorMessage(reason))
      return undefined
    }
  }

  private async currentBranch(
    host: ProjectHost,
    root: HostPath,
    lane: ExecLane = 'background',
  ): Promise<string | undefined> {
    try {
      const result = await host.exec(
        'git',
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        this.gitOptions(root, lane),
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
    maxBuffer = MAX_OUTPUT_BYTES,
    lane: ExecLane = 'background',
  ): Promise<GhResult> {
    let result
    try {
      result = await host.exec('gh', args, {
        cwd: root,
        loginShell: true,
        lane,
        timeout: GH_TIMEOUT_MS,
        maxBuffer,
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
      return {
        ok: false,
        unavailable: classifyGhFailure(result.stderr, host.hostId !== LOCAL_HOST_ID),
      }
    }
    return { ok: true, stdout: result.stdout }
  }

  private gitOptions(root: HostPath, lane: ExecLane = 'background'): ExecOptions {
    return {
      cwd: root,
      lane,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      maxStdoutNulRecords: 32_768,
    }
  }
}
