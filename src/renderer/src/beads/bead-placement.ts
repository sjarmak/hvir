import type { BeadIssue } from '../../../shared'
import type { BeadsView } from './beads-model'

/**
 * Which panel section renders each bead, by id. Beads the classification hides
 * (orchestration internals, unclassified records) and closed beads outside the
 * "show closed" view have no entry, so a caller can tell "collapsed" from "not
 * on screen at all" before it tries to focus a row.
 */
export function beadSectionKeys(
  view: BeadsView,
  closedIssues: readonly BeadIssue[] = [],
): ReadonlyMap<string, string> {
  const placement = new Map<string, string>()
  for (const section of view.sections) {
    for (const card of section.cards) placement.set(card.issue.id, section.key)
    for (const group of section.groups ?? []) {
      for (const card of group.cards) placement.set(card.issue.id, section.key)
    }
  }
  for (const issue of closedIssues) placement.set(issue.id, 'completed')
  return placement
}
