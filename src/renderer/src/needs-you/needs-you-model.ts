import {
  businessMsBetween,
  formatBusinessAge,
  pullWaitRows,
  type BeadIssue,
  type BeadsListResponse,
  type PullsResponse,
  type PullSummary,
  type PullWaitRow,
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
  /** Epoch ms of the oldest ask this item counts from. */
  readonly since: number
  /** Business-time age of the ask, as the row shows it. */
  readonly age: string
}

function feedbackReason(pull: PullSummary): readonly string[] {
  if (pull.openFeedback === 0) return []
  return [`${pull.openFeedback} feedback item${pull.openFeedback === 1 ? '' : 's'}`]
}

function reasonsOf(row: PullWaitRow, viewer: string): readonly string[] {
  const feedback = row.pull.author === viewer ? feedbackReason(row.pull) : []
  return row.list === 'needs' ? [row.reason, ...feedback] : feedback
}

/**
 * Inbound asks and the viewer's own pull requests whose ball came back (ADR-976), oldest
 * ask first, with open feedback on the viewer's own pull requests appended as a reason.
 */
export function needsYouPulls(
  response: PullsResponse,
  now: number,
): readonly NeedsYouPull[] {
  if (!response.available) return []
  return pullWaitRows(response, now)
    .flatMap((row): NeedsYouPull[] => {
      const reasons = reasonsOf(row, response.viewer)
      if (reasons.length === 0) return []
      const age = formatBusinessAge(businessMsBetween(row.since, now))
      return [{ pull: row.pull, reasons, since: row.since, age }]
    })
    .sort((left, right) => left.since - right.since)
}
