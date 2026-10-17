import type { PullReviewer, PullReviewerKind, PullReviewerState } from '../../shared'
import {
  actor,
  asRecord,
  asString,
  laterIso,
  nodesOf,
  type JsonRecord,
} from './github-json'

const REVIEWER_STATES: Readonly<Record<string, PullReviewerState>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
}

interface RequestedReviewer {
  readonly login: string
  readonly kind: PullReviewerKind
}

interface OpinionatedReview {
  readonly login: string
  readonly reviewState: PullReviewerState
  readonly reviewedAt?: string
}

/** Timestamps read from the pull request timeline (ADR-976); request times are keyed by reviewer name. */
export interface PullTimeline {
  readonly requestedAt: Readonly<Record<string, string>>
  readonly readyForReviewAt?: string
  readonly viewerAssignedAt?: string
}

const TEAM_TYPES: ReadonlySet<unknown> = new Set(['Team', 'EnterpriseTeam'])

/** Users and teams can act on a request; bots and mannequins (placeholder identities) cannot, so they are absent. */
function requestedReviewer(value: unknown): RequestedReviewer | undefined {
  const record = asRecord(value)
  const login = asString(record?.['login'])
  const slug = asString(record?.['combinedSlug'])
  if (record?.['__typename'] === 'User' && login !== undefined) {
    return { login, kind: 'user' }
  }
  if (TEAM_TYPES.has(record?.['__typename']) && slug !== undefined) {
    return { login: slug, kind: 'team' }
  }
  return undefined
}

function applyEvent(
  timeline: PullTimeline,
  event: JsonRecord,
  viewer: string,
): PullTimeline {
  const at = asString(event['createdAt'])
  if (at === undefined) return timeline
  switch (event['__typename']) {
    case 'ReviewRequestedEvent': {
      const reviewer = requestedReviewer(event['requestedReviewer'])
      if (reviewer === undefined) return timeline
      const { requestedAt } = timeline
      return {
        ...timeline,
        requestedAt: {
          ...requestedAt,
          [reviewer.login]: laterIso(requestedAt[reviewer.login], at),
        },
      }
    }
    case 'ReadyForReviewEvent':
      return { ...timeline, readyForReviewAt: laterIso(timeline.readyForReviewAt, at) }
    case 'AssignedEvent':
      return asString(asRecord(event['assignee'])?.['login']) === viewer
        ? { ...timeline, viewerAssignedAt: laterIso(timeline.viewerAssignedAt, at) }
        : timeline
    default:
      return timeline
  }
}

export function timelineOf(node: JsonRecord, viewer: string): PullTimeline {
  const timeline = nodesOf(node['timelineItems']).reduce<PullTimeline>(
    (current, event) => applyEvent(current, event, viewer),
    { requestedAt: {} },
  )
  const assigned = nodesOf(node['assignees']).some((user) => user['login'] === viewer)
  if (assigned) return timeline
  const { viewerAssignedAt: _unassigned, ...rest } = timeline
  return rest
}

function opinionatedReviews(node: JsonRecord): readonly OpinionatedReview[] {
  return nodesOf(node['latestOpinionatedReviews']).flatMap((review) => {
    const { login, bot } = actor(review['author'])
    const reviewState = REVIEWER_STATES[asString(review['state']) ?? '']
    const reviewedAt = asString(review['submittedAt'])
    if (bot || login === undefined || reviewState === undefined) return []
    return [{ login, reviewState, ...(reviewedAt === undefined ? {} : { reviewedAt }) }]
  })
}

export function reviewersOf(
  node: JsonRecord,
  requestedAt: Readonly<Record<string, string>>,
): readonly PullReviewer[] {
  const pending = nodesOf(node['reviewRequests']).flatMap((request) => {
    const reviewer = requestedReviewer(request['requestedReviewer'])
    return reviewer === undefined ? [] : [reviewer]
  })
  const reviewed = opinionatedReviews(node)
  const reviewByLogin = new Map(reviewed.map((review) => [review.login, review]))
  const pendingLogins = new Set(pending.map((reviewer) => reviewer.login))
  const requested = (login: string): Pick<PullReviewer, 'requestedAt'> => {
    const at = requestedAt[login]
    return at === undefined ? {} : { requestedAt: at }
  }
  return [
    ...pending.map((reviewer): PullReviewer => ({
      ...reviewer,
      pending: true,
      ...requested(reviewer.login),
      ...(reviewByLogin.get(reviewer.login) ?? {}),
    })),
    ...reviewed
      .filter((review) => !pendingLogins.has(review.login))
      .map((review): PullReviewer => ({
        kind: 'user',
        pending: false,
        ...requested(review.login),
        ...review,
      })),
  ]
}
