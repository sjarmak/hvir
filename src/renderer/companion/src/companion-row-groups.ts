/**
 * The Companion list reads by workspace: one group per workspace the rows
 * name, headed by its project and workspace (and its host when that is not
 * the desktop). Groups sort by name so they hold still while attention
 * moves; inside a group the rows keep the order the desktop sent, which puts
 * what is waiting on the person first.
 */
import type { CompanionRow } from '../../../shared'

export interface CompanionRowGroup {
  /** The workspace handle: stable across snapshots, so a group keeps its identity. */
  readonly key: string
  readonly project: string
  readonly workspace: string
  readonly hostLabel: string
  readonly hostKind: CompanionRow['workspace']['hostKind']
  readonly rows: readonly CompanionRow[]
}

export function groupCompanionRows(
  rows: readonly CompanionRow[],
): readonly CompanionRowGroup[] {
  const groups = new Map<string, CompanionRowGroup>()
  for (const row of rows) {
    const key = row.workspace.handle
    const group = groups.get(key)
    if (group !== undefined) {
      groups.set(key, { ...group, rows: [...group.rows, row] })
      continue
    }
    groups.set(key, {
      key,
      project: row.project.name,
      workspace: row.workspace.name,
      hostLabel: row.workspace.hostLabel,
      hostKind: row.workspace.hostKind,
      rows: [row],
    })
  }
  return [...groups.values()].sort(compareGroups)
}

/** `project / workspace`, and `on host` for a workspace that is not on the desktop. */
export function companionGroupTitle(group: CompanionRowGroup): string {
  const name = `${group.project} / ${group.workspace}`
  return group.hostKind === 'ssh' ? `${name} on ${group.hostLabel}` : name
}

function compareGroups(left: CompanionRowGroup, right: CompanionRowGroup): number {
  return (
    left.project.localeCompare(right.project) ||
    left.workspace.localeCompare(right.workspace) ||
    left.hostLabel.localeCompare(right.hostLabel) ||
    left.key.localeCompare(right.key)
  )
}
