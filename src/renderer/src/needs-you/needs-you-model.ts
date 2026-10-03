import type {
  BeadIssue,
  BeadsListResponse,
  PullsResponse,
  PullSummary,
} from '../../../shared'
import { classifyBeads } from '../beads/beads-model'

export function needsYouBeads(response: BeadsListResponse): readonly BeadIssue[] {
  if (!response.available) return []
  const view = classifyBeads(response)
  return (view.sections.find((section) => section.key === 'needsYou')?.cards ?? [])
    .map((card) => card.issue)
    .filter((issue) => issue.status !== 'closed')
}

export interface NeedsYouPull {
  readonly pull: PullSummary
  readonly reasons: readonly string[]
}

export function needsYouPulls(response: PullsResponse): readonly NeedsYouPull[] {
  if (!response.available) return []
  const requested = response.reviewRequested.filter((pull) => pull.state === 'open')
  const authored = response.authored.filter((pull) => pull.state === 'open')
  const numbers = [
    ...new Set([...requested, ...authored].map((pull) => pull.number)),
  ].sort((left, right) => left - right)
  return numbers.flatMap((number) => {
    const review = requested.find((pull) => pull.number === number)
    const own = authored.find((pull) => pull.number === number)
    const pull = own ?? review
    if (!pull) return []
    const reasons = [
      ...(review ? ['Review requested'] : []),
      ...(own?.checks === 'failing' ? ['CI failing'] : []),
      ...(own && own.openFeedback > 0
        ? [`${own.openFeedback} feedback item${own.openFeedback === 1 ? '' : 's'}`]
        : []),
    ]
    return reasons.length ? [{ pull, reasons }] : []
  })
}
