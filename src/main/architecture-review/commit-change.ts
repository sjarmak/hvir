import {
  ARCHITECTURE_LAYOUT_FILE,
  inLayoutScope,
  type ArchitectureLayout,
} from '../../shared/architecture-layout'
import type { ArchitectureCommitChange } from '../../shared/architecture-review'
import { inArchitectureScope, isSource } from './capture-entries'

export const COMMIT_CHANGE_CLASSIFIER_VERSION = 'commit-change-1'

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
export interface ImportSignature {
  readonly specifier?: string
  readonly form: string
  readonly typeOnly: boolean
}
export type ImportTable = ReadonlyMap<string, readonly ImportSignature[] | null>

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
    (entry) =>
      inScope(layout, entry) && (!isSource(entry.path) || !isModification(entry)),
  )
}

export function classifyCommitChange(
  entries: readonly CommitDiffEntry[],
  layout: ArchitectureLayout,
  imports: ImportTable,
): ArchitectureCommitChange {
  if (structurallyChanged(entries, layout)) return 'architecture'
  const modified = modifiedSources(entries, layout)
  if (modified.length === 0) return 'none'
  let change: ArchitectureCommitChange = 'code'
  for (const entry of modified) {
    const before = imports.get(entry.before)
    const after = imports.get(entry.after)
    if (before === undefined || after === undefined) change = 'unclassified'
    else if (signatureKey(before) !== signatureKey(after)) return 'architecture'
  }
  return change
}

function signatureKey(signatures: readonly ImportSignature[] | null): string {
  if (signatures === null) return ''
  return signatures
    .map((signature) =>
      JSON.stringify([signature.specifier ?? '', signature.form, signature.typeOnly]),
    )
    .sort()
    .join('\n')
}
