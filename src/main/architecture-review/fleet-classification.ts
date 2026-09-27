import type { ArchitectureLayout } from '../../shared/architecture-layout'
import type {
  ArchitectureCommitChange,
  FleetCommitClassification,
} from '../../shared/architecture-review'
import {
  modifiedSources,
  structurallyChanged,
  type CommitDiffEntry,
} from './commit-change'

export const FLEET_CLASSIFICATION_NOTES_REF = 'refs/notes/classification'
const FLEET_LOG = [
  'log',
  '--no-walk=unsorted',
  `--notes=${FLEET_CLASSIFICATION_NOTES_REF}`,
  '--format=%x1e%H%x1f%(trailers:only,unfold)%x1f%N',
] as const
const RECORD = '\x1e'
const FIELD = '\x1f'
const HASH = /^[a-f0-9]{40,64}$/
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/
const CONTINUATION = /^[ \t]/
const MAX_VALUE_LENGTH = 200
const ARCHITECTURAL = 'architectural'

type Run = (args: readonly string[]) => Promise<string>
type Trailers = ReadonlyMap<string, readonly string[]>
interface Trailer {
  readonly key: string
  readonly value: string
}

export async function readFleetClassifications(
  run: Run,
  revisions: readonly string[],
): Promise<ReadonlyMap<string, FleetCommitClassification>> {
  const found = new Map<string, FleetCommitClassification>()
  if (revisions.length === 0) return found
  const output = await run([...FLEET_LOG, ...revisions, '--'])
  for (const record of output.split(RECORD)) {
    const [revision = '', message = '', note = ''] = record.split(FIELD)
    if (!HASH.test(revision)) continue
    const classification = parseFleetClassification(note.trim() === '' ? message : note)
    if (classification) found.set(revision, classification)
  }
  return found
}

export function parseFleetClassification(
  text: string,
): FleetCommitClassification | undefined {
  const trailers = parseTrailers(text)
  const first = (key: string) => trailers.get(key)?.[0]
  const type = first('change-type')
  if (type === undefined) return undefined
  return {
    type,
    ...present('scope', first('change-scope')),
    ...present('architectural', first('architectural')),
    ...present('behavior', first('behavior')),
    ...present('compatibility', first('compatibility')),
    ...present('risk', first('risk')),
    beads: trailers.get('bead') ?? [],
    ...present('classifiedBy', first('classified-by')),
  }
}

export function fleetCommitChange(
  fleet: FleetCommitClassification,
  entries: readonly CommitDiffEntry[],
  layout: ArchitectureLayout,
): ArchitectureCommitChange {
  if (fleet.architectural?.toLowerCase() === ARCHITECTURAL) return 'architecture'
  if (structurallyChanged(entries, layout) || modifiedSources(entries, layout).length > 0)
    return 'code'
  return 'none'
}

function parseTrailers(text: string): Trailers {
  const entries: Trailer[] = []
  let open = false
  for (const line of text.split('\n')) {
    const match = TRAILER.exec(line)
    if (match) {
      entries.push({ key: match[1]!.toLowerCase(), value: match[2]! })
      open = true
      continue
    }
    const previous = entries.at(-1)
    if (open && previous && CONTINUATION.test(line)) {
      entries[entries.length - 1] = {
        ...previous,
        value: `${previous.value} ${line.trim()}`,
      }
      continue
    }
    open = false
  }
  const trailers = new Map<string, readonly string[]>()
  for (const { key, value } of entries) {
    const trimmed = value.trim()
    if (!acceptable(trimmed)) continue
    trailers.set(key, [...(trailers.get(key) ?? []), trimmed])
  }
  return trailers
}

function acceptable(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !/\p{Cc}/u.test(value)
}

function present<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, string>>)
}
