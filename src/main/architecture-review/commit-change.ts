import {
  ARCHITECTURE_LAYOUT_FILE,
  inLayoutScope,
  type ArchitectureLayout,
} from '../../shared/architecture-layout'
import type {
  ArchitectureAnalysis,
  ArchitectureImportFact,
} from '../../shared/architecture-analysis'
import type { ArchitectureCommitChange } from '../../shared/architecture-review'
import { inArchitectureScope, isSource } from './capture-entries'

export const COMMIT_CHANGE_CLASSIFIER_VERSION = 'commit-change-3'

export interface CommitDiffEntry {
  readonly path: string
  readonly status: string
  readonly before: string
  readonly after: string
}
export interface CommitDiff {
  readonly revision: string
  readonly parents: readonly string[]
  readonly entries: readonly CommitDiffEntry[]
}
export type EdgeTable = ReadonlyMap<string, readonly string[] | null>

export const edgeKey = (side: string, object: string): string => `${side}\0${object}`

const HASH = /^[a-f0-9]{40,64}$/
const RAW_ENTRY = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([A-Z])(\d*)$/
const RECORD = '\x1e'
const FIELD = '\x1f'

export function parseCommitDiffs(output: string): readonly CommitDiff[] {
  return output
    .split(RECORD)
    .filter(Boolean)
    .map((record) => {
      const [header = '', ...rest] = record.split('\0')
      const [revision = '', parents = ''] = header.split(FIELD)
      if (!HASH.test(revision)) throw new Error('Malformed Git log entry')
      const fields = rest.map((field) => field.replace(/^\n/, '')).filter(Boolean)
      const entries: CommitDiffEntry[] = []
      for (let index = 0; index < fields.length; index += 2) {
        const match = RAW_ENTRY.exec(fields[index] ?? '')
        const path = fields[index + 1]
        if (!match || path === undefined) throw new Error('Malformed Git raw diff entry')
        entries.push({ path, status: match[5]!, before: match[3]!, after: match[4]! })
      }
      return { revision, parents: parents.split(' ').filter(Boolean), entries }
    })
}

function inScope(layout: ArchitectureLayout, entry: CommitDiffEntry): boolean {
  if (entry.path === ARCHITECTURE_LAYOUT_FILE) return true
  if (!inArchitectureScope(entry.path)) return false
  return !isSource(entry.path) || inLayoutScope(layout, entry.path)
}

const isModification = (entry: CommitDiffEntry): boolean =>
  entry.status === 'M' || entry.status === 'T'

export function modifiedSources(
  entries: readonly CommitDiffEntry[],
  layout: ArchitectureLayout,
): readonly CommitDiffEntry[] {
  return entries.filter(
    (entry) => inScope(layout, entry) && isSource(entry.path) && isModification(entry),
  )
}

export function structurallyChanged(
  entries: readonly CommitDiffEntry[],
  layout: ArchitectureLayout,
): boolean {
  return entries.some(
    (entry) => inScope(layout, entry) && isSource(entry.path) && !isModification(entry),
  )
}

export function configChanged(
  entries: readonly CommitDiffEntry[],
  layout: ArchitectureLayout,
): boolean {
  return entries.some((entry) => inScope(layout, entry) && !isSource(entry.path))
}

export function classifyCommitChange(
  diff: CommitDiff,
  layout: ArchitectureLayout,
  edges: EdgeTable,
  scanned?: ArchitectureCommitChange,
): ArchitectureCommitChange {
  const { entries } = diff
  if (structurallyChanged(entries, layout)) return 'architecture'
  if (configChanged(entries, layout)) return scanned ?? 'unclassified'
  const modified = modifiedSources(entries, layout)
  if (modified.length === 0) return 'none'
  const parent = diff.parents[0]
  if (parent === undefined) return 'unclassified'
  let change: ArchitectureCommitChange = 'code'
  for (const entry of modified) {
    const before = edges.get(edgeKey(parent, entry.before))
    const after = edges.get(edgeKey(diff.revision, entry.after))
    if (before === undefined || after === undefined) change = 'unclassified'
    else if (!sameSet(new Set(before ?? []), new Set(after ?? []))) return 'architecture'
  }
  return change
}

export function changeFromAnalysis(
  analysis: ArchitectureAnalysis,
  modifiedSourceCount: number,
): ArchitectureCommitChange {
  const placed = (side: ArchitectureAnalysis['before']) =>
    new Set(
      side.modules.map(
        (module) => `${module.path}\0${module.system}\0${module.subsystem}`,
      ),
    )
  const edges = (
    kept: (change: ArchitectureAnalysis['imports'][number]['change']) => boolean,
  ) => new Set(analysis.imports.filter((fact) => kept(fact.change)).map(edgeOfFact))
  const remapped = !sameSet(placed(analysis.before), placed(analysis.after))
  const rewired = !sameSet(
    edges((change) => change !== 'added'),
    edges((change) => change !== 'removed'),
  )
  if (remapped || rewired) return 'architecture'
  return modifiedSourceCount > 0 ? 'code' : 'none'
}

export function edgeOfFact(fact: ArchitectureImportFact): string {
  return `${fact.source}\0${fact.target ?? `${fact.resolution}: ${fact.specifier}`}`
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item))
}
