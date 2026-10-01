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

type JsonRecord = Readonly<Record<string, unknown>>

export interface ParsedPulls {
  readonly viewer: string
  readonly branchPulls: readonly PullSummary[]
  readonly authored: readonly PullSummary[]
  readonly reviewRequested: readonly PullSummary[]
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
  const rollup = asString(asRecord(headCommit?.['statusCheckRollup'])?.['state'])
  const headCommittedAt = asString(headCommit?.['committedDate'])
  const author = actor(node['author']).login ?? ''
  return {
    number,
    title,
    url,
    state: STATES[asString(node['state']) ?? ''] ?? 'open',
    draft: node['isDraft'] === true,
    headRef: asString(node['headRefName']) ?? '',
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
  return {
    viewer,
    branchPulls: pullsOf(asRecord(data['repository'])?.['branch'], viewer, (node) => {
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
