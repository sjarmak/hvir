export const ARCHITECTURE_EXPLANATION_FILE = '.hvir-architecture-explanation.json'
export const ARCHITECTURE_EXPLANATION_MAX_BYTES = 64 * 1024

export interface ArchitectureExplanationClaim {
  readonly version: 1
  readonly snapshotId: string
  readonly whatChanged: string
  readonly why: string
  readonly sequenceDiagram: string
  readonly touched: {
    readonly systems: readonly string[]
    readonly subsystems: readonly string[]
    readonly modules: readonly string[]
  }
}

export interface ArchitectureExplanationName {
  readonly name: string
  readonly present: boolean
}

export interface ArchitectureExplanation {
  readonly snapshotId: string
  readonly claim: ArchitectureExplanationClaim
  readonly names: {
    readonly systems: readonly ArchitectureExplanationName[]
    readonly subsystems: readonly ArchitectureExplanationName[]
    readonly modules: readonly ArchitectureExplanationName[]
  }
}

export type ArchitectureExplanationState =
  | { readonly status: 'waiting'; readonly snapshotId: string }
  | { readonly status: 'invalid'; readonly snapshotId: string; readonly message: string }
  | { readonly status: 'ready'; readonly explanation: ArchitectureExplanation }

export class ArchitectureExplanationError extends Error {}

interface ArchitectureExplanationSnapshot {
  readonly id: string
  readonly analysis: {
    readonly modules: readonly {
      readonly system: string
      readonly subsystem: string
      readonly path: string
    }[]
  }
}

const ROOT_KEYS = [
  'version',
  'snapshotId',
  'whatChanged',
  'why',
  'sequenceDiagram',
  'touched',
] as const
const TOUCHED_KEYS = ['systems', 'subsystems', 'modules'] as const
const MAX_TEXT = 8_000
const MAX_DIAGRAM = 16_000
const MAX_NAMES = 256
const MAX_NAME = 1_024

export function parseArchitectureExplanation(text: string): ArchitectureExplanationClaim {
  if (new TextEncoder().encode(text).length > ARCHITECTURE_EXPLANATION_MAX_BYTES)
    throw new ArchitectureExplanationError('Explanation is larger than 64 KiB')
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new ArchitectureExplanationError(`Explanation is not valid JSON: ${reason}`)
  }
  const record = exactObject(value, ROOT_KEYS, 'Explanation')
  if (record.version !== 1)
    throw new ArchitectureExplanationError('Explanation version must be 1')
  const touched = exactObject(record.touched, TOUCHED_KEYS, 'Explanation touched')
  return {
    version: 1,
    snapshotId: textValue(record.snapshotId, 'snapshotId', 128),
    whatChanged: textValue(record.whatChanged, 'whatChanged', MAX_TEXT),
    why: textValue(record.why, 'why', MAX_TEXT),
    sequenceDiagram: diagramValue(record.sequenceDiagram),
    touched: {
      systems: nameList(touched.systems, 'systems'),
      subsystems: nameList(touched.subsystems, 'subsystems'),
      modules: nameList(touched.modules, 'modules'),
    },
  }
}

function diagramValue(value: unknown): string {
  const diagram = textValue(value, 'sequenceDiagram', MAX_DIAGRAM)
  const directives = diagram
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'sequenceDiagram')
  if (
    diagram
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() !== 'sequenceDiagram'
  )
    throw new ArchitectureExplanationError(
      'sequenceDiagram must start with sequenceDiagram',
    )
  if (directives.length !== 1)
    throw new ArchitectureExplanationError(
      'sequenceDiagram must contain exactly one diagram',
    )
  return diagram
}

export function checkArchitectureExplanation(
  claim: ArchitectureExplanationClaim,
  snapshot: ArchitectureExplanationSnapshot,
): ArchitectureExplanation {
  if (claim.snapshotId !== snapshot.id)
    throw new ArchitectureExplanationError('Explanation names a different snapshot')
  const systems = new Set(snapshot.analysis.modules.map((module) => module.system))
  const subsystems = new Set(snapshot.analysis.modules.map((module) => module.subsystem))
  const modules = new Set(snapshot.analysis.modules.map((module) => module.path))
  return {
    snapshotId: snapshot.id,
    claim,
    names: {
      systems: checkedNames(claim.touched.systems, systems),
      subsystems: checkedNames(claim.touched.subsystems, subsystems),
      modules: checkedNames(claim.touched.modules, modules),
    },
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ArchitectureExplanationError(`${label} must be an object`)
  const record = value as Readonly<Record<string, unknown>>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.join() !== expected.join())
    throw new ArchitectureExplanationError(
      `${label} must contain exactly ${keys.join(', ')}`,
    )
  return record
}

function textValue(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value.replace(/\n/g, ''))
  )
    throw new ArchitectureExplanationError(
      `${field} must be 1 to ${maximum} characters without surrounding whitespace or unsupported control characters`,
    )
  return value
}

function nameList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_NAMES)
    throw new ArchitectureExplanationError(
      `${field} must be an array of at most ${MAX_NAMES} names`,
    )
  const names = value.map((entry) => textValue(entry, field, MAX_NAME))
  if (new Set(names).size !== names.length)
    throw new ArchitectureExplanationError(`${field} must not repeat a name`)
  return names
}

function checkedNames(
  names: readonly string[],
  present: ReadonlySet<string>,
): readonly ArchitectureExplanationName[] {
  return names.map((name) => ({ name, present: present.has(name) }))
}
