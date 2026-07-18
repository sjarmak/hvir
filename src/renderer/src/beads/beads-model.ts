import type { BeadIssue } from '../../../shared'

/**
 * Pure grouping/sorting for the beads rail panel. Statuses outside the known
 * set land in the "open" section so a bd upgrade never blanks the view.
 */

export type BeadsSectionKey = 'inProgress' | 'ready' | 'blocked' | 'open' | 'deferred'

export interface BeadsSection {
  readonly key: BeadsSectionKey
  readonly label: string
  readonly issues: readonly BeadIssue[]
}

const SECTION_LABELS: Record<BeadsSectionKey, string> = {
  inProgress: 'In Progress',
  ready: 'Ready',
  blocked: 'Blocked',
  open: 'Open',
  deferred: 'Deferred',
}

export function groupBeads(
  issues: readonly BeadIssue[],
  readyIds: readonly string[],
): readonly BeadsSection[] {
  const ready = new Set(readyIds)
  const buckets: Record<BeadsSectionKey, BeadIssue[]> = {
    inProgress: [],
    ready: [],
    blocked: [],
    open: [],
    deferred: [],
  }
  for (const issue of issues) {
    buckets[sectionFor(issue, ready)].push(issue)
  }
  return (Object.keys(SECTION_LABELS) as readonly BeadsSectionKey[]).map((key) => ({
    key,
    label: SECTION_LABELS[key],
    issues: sortBeads(buckets[key]),
  }))
}

function sectionFor(issue: BeadIssue, ready: ReadonlySet<string>): BeadsSectionKey {
  switch (issue.status) {
    case 'in_progress':
      return 'inProgress'
    case 'blocked':
      return 'blocked'
    case 'deferred':
      return 'deferred'
    default:
      return ready.has(issue.id) ? 'ready' : 'open'
  }
}

/** Highest priority first, then most recently updated, then stable by id. */
export function sortBeads(issues: readonly BeadIssue[]): readonly BeadIssue[] {
  return [...issues].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority
    const updated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    if (updated !== 0) return updated
    return left.id.localeCompare(right.id)
  })
}

export function priorityLabel(priority: number): string {
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) return 'P?'
  return `P${priority}`
}
