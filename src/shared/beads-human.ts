import type { BeadIssue } from './beads'
import { classifyIssueType, type BeadCategory } from './beads-taxonomy'

export const NEEDS_HUMAN_LABEL = 'needs-human'
export const HUMAN_ASK_LABEL = 'needs/stephanie'

type HumanSignals = Pick<BeadIssue, 'issueType' | 'labels' | 'status' | 'metadata'>

const HIDDEN_CATEGORIES: ReadonlySet<BeadCategory> = new Set([
  'orchestration',
  'infra',
  'gate',
  'unknown',
])

function hasLabel(issue: HumanSignals, label: string): boolean {
  return issue.labels.some((candidate) => candidate.toLowerCase() === label)
}

function isAnswered(issue: HumanSignals): boolean {
  return (issue.metadata?.['gc.answered']?.length ?? 0) > 0
}

function isHumanAsk(issue: HumanSignals): boolean {
  if (issue.status === 'closed') return false
  if (hasLabel(issue, HUMAN_ASK_LABEL)) return true
  const type = issue.issueType.trim().toLowerCase()
  return type === 'decision' || type === 'dec' || type === 'adr'
}

export function isAnsweredAsk(issue: HumanSignals): boolean {
  return isHumanAsk(issue) && isAnswered(issue)
}

export function beadNeedsHuman(issue: HumanSignals): boolean {
  if (HIDDEN_CATEGORIES.has(classifyIssueType(issue.issueType))) return false
  if (hasLabel(issue, NEEDS_HUMAN_LABEL)) return true
  return isHumanAsk(issue) && !isAnswered(issue)
}

export function isOpenLabelledAsk(issue: HumanSignals): boolean {
  return issue.status === 'open' && hasLabel(issue, HUMAN_ASK_LABEL) && !isAnswered(issue)
}
