import type {
  PullChecks,
  PullReview,
  PullState,
  PullSummary,
  PullsUnavailable,
} from '../../shared'
import {
  openFeedbackCount,
  type FeedbackComment,
  type FeedbackReview,
  type FeedbackThread,
} from './pr-feedback'
import type { PullDetail, PullReviewComment, PullReviewThread } from '../../shared'

type JsonRecord = Readonly<Record<string, unknown>>

export interface ParsedPulls {
  readonly viewer: string
  readonly branchPulls: readonly PullSummary[]
  readonly authored: readonly PullSummary[]
  readonly reviewRequested: readonly PullSummary[]
}

export function parsePullDetailOutput(
  stdout: string,
  repo: string,
  expectedNumber: number,
): PullDetail {
  const parsed: unknown = JSON.parse(stdout)
  const root = asRecord(parsed)
  const errors = root?.['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map(
      (error) => asString(asRecord(error)?.['message']) ?? 'unknown',
    )
    throw new Error(`GitHub GraphQL error: ${messages.join('; ')}`)
  }
  const pull = asRecord(
    asRecord(asRecord(root?.['data'])?.['repository'])?.['pullRequest'],
  )
  if (pull === undefined) throw new Error('GitHub pull request detail was not found')
  const number = pull['number']
  const title = asString(pull['title'])
  const url = asString(pull['url'])
  if (number !== expectedNumber || title === undefined || url === undefined) {
    throw new Error('GitHub pull request detail identity did not match the request')
  }
  const headOid = asString(pull['headRefOid'])
  const connection = asRecord(pull['reviewThreads'])
  const threads = nodesOf(connection).map((node): PullReviewThread => {
    const commentsConnection = asRecord(node['comments'])
    const comments = nodesOf(commentsConnection).map((comment): PullReviewComment => {
      const author = asString(asRecord(comment['author'])?.['login'])
      const createdAt = asString(comment['createdAt'])
      const commitOid = asString(asRecord(comment['commit'])?.['oid'])
      return {
        id: asString(comment['id']) ?? '',
        body: asString(comment['body']) ?? '',
        ...(author === undefined ? {} : { author }),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(commitOid === undefined ? {} : { commitOid }),
      }
    })
    const first = comments[0]
    const path = asString(node['path'])
    const line = typeof node['line'] === 'number' ? node['line'] : undefined
    const reviewedCommitOid = first?.commitOid
    const commentsPageComplete =
      asRecord(commentsConnection?.['pageInfo'])?.['hasNextPage'] === false
    return {
      id: asString(node['id']) ?? '',
      body: first?.body ?? '',
      ...(first?.author === undefined ? {} : { author: first.author }),
      ...(path === undefined ? {} : { path }),
      ...(line === undefined ? {} : { line }),
      isResolved: node['isResolved'] === true,
      isOutdated: node['isOutdated'] === true,
      ...(reviewedCommitOid === undefined ? {} : { reviewedCommitOid }),
      comments,
      commentsPageComplete,
    }
  })
  const threadsPageComplete =
    asRecord(connection?.['pageInfo'])?.['hasNextPage'] === false
  const payloadTruncated =
    !threadsPageComplete || threads.some((thread) => !thread.commentsPageComplete)
  return {
    available: true,
    repo,
    number,
    url,
    title,
    ...(headOid === undefined ? {} : { headOid }),
    threads,
    threadsPageComplete,
    payloadTruncated,
  }
}

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const GITHUB_REMOTE_PATTERN =
  /(?:^|\s)(?:(?:https?|ssh):\/\/(?:[^@/\s]+@)?github\.com[/:]|[^@/\s]+@github\.com:)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?=\s|$)/gm

const CHECKS: Readonly<Record<string, PullChecks>> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
}

const REVIEWS: Readonly<Record<string, PullReview>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
}

const STATES: Readonly<Record<string, PullState>> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nodesOf(connection: unknown): readonly JsonRecord[] {
  const nodes = asRecord(connection)?.['nodes']
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((node) => {
    const record = asRecord(node)
    return record === undefined ? [] : [record]
  })
}

function actor(value: unknown): { readonly login?: string; readonly bot: boolean } {
  const record = asRecord(value)
  const login = asString(record?.['login'])
  return {
    ...(login === undefined ? {} : { login }),
    bot: record?.['__typename'] === 'Bot',
  }
}

function threadsOf(node: JsonRecord): readonly FeedbackThread[] {
  return nodesOf(node['reviewThreads']).map((thread) => ({
    isResolved: thread['isResolved'] === true,
    isOutdated: thread['isOutdated'] === true,
  }))
}

function reviewsOf(node: JsonRecord): readonly FeedbackReview[] {
  return nodesOf(node['reviews']).map((review) => {
    const { login, bot } = actor(review['author'])
    const submittedAt = asString(review['submittedAt'])
    return {
      state: asString(review['state']) ?? '',
      body: asString(review['body']) ?? '',
      bot,
      ...(submittedAt === undefined ? {} : { submittedAt }),
      ...(login === undefined ? {} : { author: login }),
    }
  })
}

function commentsOf(node: JsonRecord): readonly FeedbackComment[] {
  return nodesOf(node['comments']).map((comment) => {
    const { login, bot } = actor(comment['author'])
    const createdAt = asString(comment['createdAt'])
    return {
      bot,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(login === undefined ? {} : { author: login }),
    }
  })
}

function headRepositoryOf(node: JsonRecord): string | undefined {
  return asString(asRecord(node['headRepository'])?.['nameWithOwner'])?.toLowerCase()
}

function parsePull(node: JsonRecord, viewer: string): PullSummary | undefined {
  const number = node['number']
  const title = asString(node['title'])
  const url = asString(node['url'])
  if (typeof number !== 'number' || title === undefined || url === undefined)
    return undefined
  const headCommit = asRecord(nodesOf(node['commits'])[0]?.['commit'])
  const headOid = asString(headCommit?.['oid'])
  const rollup = asString(asRecord(headCommit?.['statusCheckRollup'])?.['state'])
  const headCommittedAt = asString(headCommit?.['committedDate'])
  const author = actor(node['author']).login ?? ''
  const headRepo = headRepositoryOf(node)
  return {
    number,
    title,
    url,
    state: STATES[asString(node['state']) ?? ''] ?? 'open',
    draft: node['isDraft'] === true,
    headRef: asString(node['headRefName']) ?? '',
    ...(headRepo === undefined ? {} : { headRepo }),
    author,
    updatedAt: asString(node['updatedAt']) ?? '',
    checks: CHECKS[rollup ?? ''] ?? 'none',
    review: REVIEWS[asString(node['reviewDecision']) ?? ''] ?? 'none',
    openFeedback:
      author !== viewer
        ? 0
        : openFeedbackCount(
            {
              ...(headCommittedAt === undefined ? {} : { headCommittedAt }),
              threads: threadsOf(node),
              reviews: reviewsOf(node),
              comments: commentsOf(node),
            },
            viewer,
          ),
    ...(headOid === undefined ? {} : { headOid }),
  }
}

function pullsOf(
  connection: unknown,
  viewer: string,
  keep: (node: JsonRecord) => boolean = () => true,
): readonly PullSummary[] {
  return nodesOf(connection).flatMap((node) => {
    if (!keep(node)) return []
    const pull = parsePull(node, viewer)
    return pull === undefined ? [] : [pull]
  })
}

export function parsePullsOutput(
  stdout: string,
  localRepos: ReadonlySet<string>,
  currentBranch: string | undefined,
): ParsedPulls {
  const parsed: unknown = JSON.parse(stdout)
  const root = asRecord(parsed)
  const errors = root?.['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map(
      (error) => asString(asRecord(error)?.['message']) ?? 'unknown',
    )
    throw new Error(`GitHub GraphQL error: ${messages.join('; ')}`)
  }
  const data = asRecord(root?.['data'])
  if (data === undefined) throw new Error('GitHub GraphQL response carried no data')
  const viewer = asString(asRecord(data['viewer'])?.['login']) ?? ''
  const repository = asRecord(data['repository'])
  const defaultBranch = asString(asRecord(repository?.['defaultBranchRef'])?.['name'])
  return {
    viewer,
    branchPulls:
      currentBranch !== undefined && currentBranch === defaultBranch
        ? []
        : pullsOf(repository?.['branch'], viewer, (node) => {
            const head = headRepositoryOf(node)
            return head !== undefined && localRepos.has(head)
          }),
    authored: pullsOf(data['mine'], viewer),
    reviewRequested: pullsOf(data['review'], viewer),
  }
}

export function parseRepoView(stdout: string): string {
  const name = asString(asRecord(JSON.parse(stdout) as unknown)?.['nameWithOwner'])
  if (name === undefined || !REPO_PATTERN.test(name)) {
    throw new Error('gh repo view returned no usable owner/name')
  }
  return name
}

export function githubRemoteRepos(remoteOutput: string): ReadonlySet<string> {
  return new Set(
    [...remoteOutput.matchAll(GITHUB_REMOTE_PATTERN)].map(([, owner = '', name = '']) =>
      `${owner}/${name}`.toLowerCase(),
    ),
  )
}

export function githubRemoteRepositoryMap(
  remoteOutput: string,
): ReadonlyMap<string, string | undefined> {
  const remotes = new Map<string, Set<string>>()
  for (const line of remoteOutput.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line)
    if (!match) continue
    const remote = match[1]
    const url = match[2]
    if (remote === undefined || url === undefined) continue
    const repo = [...url.matchAll(GITHUB_REMOTE_PATTERN)][0]
    const value = repo === undefined ? undefined : `${repo[1]}/${repo[2]}`.toLowerCase()
    const values = remotes.get(remote) ?? new Set<string>()
    if (value !== undefined) values.add(value)
    else values.add('')
    remotes.set(remote, values)
  }
  return new Map(
    [...remotes].map(([remote, values]) => [
      remote,
      values.size === 1 && !values.has('') ? [...values][0] : undefined,
    ]),
  )
}

export interface BranchUpstream {
  readonly branch: string
  readonly headRepo?: string
  readonly headRef?: string
}

export function parseBranchUpstreams(
  output: string,
  remoteRepositories: ReadonlyMap<string, string | undefined>,
): ReadonlyMap<string, BranchUpstream> {
  const result = new Map<string, BranchUpstream>()
  const fields = output.replace(/\r?\n/g, '').split('\0')
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const branch = (fields[index] ?? '').replace(/\r?\n$/, '')
    const remote = (fields[index + 1] ?? '').replace(/\r?\n$/, '')
    const remoteRef = (fields[index + 2] ?? '').replace(/\r?\n$/, '')
    if (!branch) continue
    const headRef =
      remote !== '.' && remote !== '' && remoteRef.startsWith('refs/heads/')
        ? remoteRef.slice('refs/heads/'.length)
        : undefined
    const headRepo = headRef === undefined ? undefined : remoteRepositories.get(remote)
    result.set(branch, {
      branch,
      ...(headRepo === undefined || headRef === undefined ? {} : { headRepo, headRef }),
    })
  }
  return result
}

export function classifyGhFailure(stderr: string): PullsUnavailable {
  const message = stderr.trim() === '' ? 'gh exited without output' : stderr.trim()
  if (
    /gh auth login|not logged in|authentication required|bad credentials/i.test(stderr)
  ) {
    return { available: false, reason: 'gh-unauthenticated', message }
  }
  if (/rate limit/i.test(stderr))
    return { available: false, reason: 'rate-limited', message }
  if (
    /git remotes|not a git repository|could not resolve to a repository/i.test(stderr)
  ) {
    return { available: false, reason: 'no-github-repo', message }
  }
  return { available: false, reason: 'error', message }
}
