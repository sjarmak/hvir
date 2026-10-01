export interface FeedbackThread {
  readonly isResolved: boolean
  readonly isOutdated: boolean
}

export interface FeedbackReview {
  readonly state: string
  readonly body: string
  readonly submittedAt?: string
  readonly author?: string
  readonly bot: boolean
}

export interface FeedbackComment {
  readonly createdAt?: string
  readonly author?: string
  readonly bot: boolean
}

export interface FeedbackNode {
  readonly headCommittedAt?: string
  readonly threads: readonly FeedbackThread[]
  readonly reviews: readonly FeedbackReview[]
  readonly comments: readonly FeedbackComment[]
}

const ACTIONABLE_REVIEW_STATES: ReadonlySet<string> = new Set([
  'COMMENTED',
  'CHANGES_REQUESTED',
])

function supersededByPush(
  at: string | undefined,
  headCommittedAt: string | undefined,
): boolean {
  if (at === undefined || headCommittedAt === undefined) return false
  const written = Date.parse(at)
  const head = Date.parse(headCommittedAt)
  if (Number.isNaN(written) || Number.isNaN(head)) return false
  return written <= head
}

export function openFeedbackCount(node: FeedbackNode, viewer: string): number {
  const threads = node.threads.filter(
    (thread) => !thread.isResolved && !thread.isOutdated,
  )
  const reviews = node.reviews.filter(
    (review) =>
      ACTIONABLE_REVIEW_STATES.has(review.state) &&
      review.body.trim() !== '' &&
      review.author !== viewer &&
      !supersededByPush(review.submittedAt, node.headCommittedAt),
  )
  const comments = node.comments.filter(
    (comment) =>
      !comment.bot &&
      comment.author !== viewer &&
      !supersededByPush(comment.createdAt, node.headCommittedAt),
  )
  return threads.length + reviews.length + comments.length
}
