/**
 * How an architecture review names subsystems and what it scans (ADR-063). A tracked file at
 * the scan root may override the defaults, so an agent in a worktree can read and change it.
 */
export const ARCHITECTURE_LAYOUT_FILE = '.hvir/architecture.json'

export interface ArchitectureSubsystemRule {
  readonly name: string
  /** Repository-relative directories or files whose modules belong to `name`. */
  readonly paths: readonly string[]
}

export interface ArchitectureLayout {
  /** `override` when the Current end carries the layout file. */
  readonly origin: 'default' | 'override'
  /** Paths a scan reads sources from; empty means the whole repository. */
  readonly scope: readonly string[]
  /** A module's default subsystem is the first directory under its source root. */
  readonly sourceRoots: readonly string[]
  readonly subsystems: readonly ArchitectureSubsystemRule[]
}

export const ARCHITECTURE_DEFAULT_LAYOUT: ArchitectureLayout = {
  origin: 'default',
  scope: [],
  sourceRoots: ['src'],
  subsystems: [],
}
export const ARCHITECTURE_ROOT_SUBSYSTEM = '(repository root)'

const MAX_LAYOUT_BYTES = 64 * 1024
const MAX_ENTRIES = 256
const MAX_NAME_LENGTH = 80
const RESERVED_PREFIXES = ['external:', 'unresolved:'] as const
const LAYOUT_KEYS = ['version', 'scope', 'sourceRoots', 'subsystems'] as const
const RULE_KEYS = ['name', 'paths'] as const

/** Refused layout text; the message names the offending field. */
export class ArchitectureLayoutError extends Error {}

/** Strictly reads the layout file's text; anything it does not define is refused. */
export function parseArchitectureLayout(text: string): ArchitectureLayout {
  if (new TextEncoder().encode(text).length > MAX_LAYOUT_BYTES)
    throw new ArchitectureLayoutError('The file is larger than 64 KiB')
  const value = parseJson(text)
  const record = objectWithKeys(value, LAYOUT_KEYS, 'The file')
  if (record.version !== 1) throw new ArchitectureLayoutError('"version" must be 1')
  const scope = record.scope === undefined ? [] : pathList(record.scope, 'scope')
  if (record.scope !== undefined && scope.length === 0)
    throw new ArchitectureLayoutError(
      '"scope" must list at least one path; leave it out to scan the whole repository',
    )
  return {
    origin: 'override',
    scope,
    sourceRoots:
      record.sourceRoots === undefined
        ? ARCHITECTURE_DEFAULT_LAYOUT.sourceRoots
        : pathList(record.sourceRoots, 'sourceRoots'),
    subsystems: record.subsystems === undefined ? [] : subsystemRules(record.subsystems),
  }
}

/** The most specific rule wins; otherwise the first directory under the source root. */
export function subsystemOf(layout: ArchitectureLayout, path: string): string {
  const rule = mostSpecific(
    layout.subsystems.flatMap((entry) =>
      entry.paths.map((prefix) => ({ prefix, name: entry.name })),
    ),
    path,
  )
  if (rule) return rule.name
  const root = mostSpecific(
    layout.sourceRoots.map((prefix) => ({ prefix })),
    path,
  )
  const base = root ? `${root.prefix}/` : ''
  const rest = path.slice(base.length).split('/')
  if (rest.length > 1) return `${base}${rest[0]}`
  return root ? root.prefix : ARCHITECTURE_ROOT_SUBSYSTEM
}

/**
 * Why a chosen scope cannot be recorded, or undefined when it can. The rules are the layout
 * file's own, so a scope that saves always parses back; empty means the whole repository.
 */
export function architectureScopeProblem(scope: readonly unknown[]): string | undefined {
  if (scope.length === 0) return undefined
  try {
    pathList(scope, 'scope')
    return undefined
  } catch (error) {
    if (error instanceof ArchitectureLayoutError) return error.message
    throw error
  }
}

export function inLayoutScope(layout: ArchitectureLayout, path: string): boolean {
  return layout.scope.length === 0 || layout.scope.some((prefix) => covers(prefix, path))
}

function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function mostSpecific<T extends { readonly prefix: string }>(
  entries: readonly T[],
  path: string,
): T | undefined {
  return entries
    .filter((entry) => covers(entry.prefix, path))
    .reduce<T | undefined>(
      (best, entry) => (!best || entry.prefix.length > best.prefix.length ? entry : best),
      undefined,
    )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ArchitectureLayoutError(`The file is not valid JSON: ${reason}`)
  }
}

function objectWithKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ArchitectureLayoutError(`${label} must be a JSON object`)
  const unknown = Object.keys(value).find((key) => !keys.includes(key))
  if (unknown !== undefined)
    throw new ArchitectureLayoutError(`${label} has unknown key "${unknown}"`)
  return value as Readonly<Record<string, unknown>>
}

function arrayOf(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new ArchitectureLayoutError(`"${field}" must be an array`)
  if (value.length > MAX_ENTRIES)
    throw new ArchitectureLayoutError(`"${field}" lists more than ${MAX_ENTRIES} entries`)
  return value
}

function pathList(value: unknown, field: string): readonly string[] {
  const paths = arrayOf(value, field).map((entry, index) =>
    repositoryPath(entry, `${field}[${index}]`),
  )
  paths.forEach((path, index) => {
    if (paths.indexOf(path) !== index)
      throw new ArchitectureLayoutError(`"${field}[${index}]" repeats "${path}"`)
  })
  return paths
}

/** A plain relative path: no empty, `.` or `..` segment, no backslash or control character. */
function repositoryPath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\\') ||
    /\p{Cc}/u.test(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new ArchitectureLayoutError(
      `"${field}" must be a relative path like "src/main", without ".", ".." or a leading or trailing "/"`,
    )
  return value
}

function subsystemRules(value: unknown): readonly ArchitectureSubsystemRule[] {
  const owners = new Map<string, string>()
  const names = new Set<string>()
  return arrayOf(value, 'subsystems').map((entry, index) => {
    const field = `subsystems[${index}]`
    const record = objectWithKeys(entry, RULE_KEYS, `"${field}"`)
    const name = subsystemName(record.name, `${field}.name`)
    if (names.has(name))
      throw new ArchitectureLayoutError(`"${field}.name" repeats "${name}"`)
    names.add(name)
    const paths = pathList(record.paths, `${field}.paths`)
    paths.forEach((path, pathIndex) => {
      const owner = owners.get(path)
      if (owner !== undefined)
        throw new ArchitectureLayoutError(
          `"${field}.paths[${pathIndex}]" is already mapped to "${owner}"`,
        )
      owners.set(path, name)
    })
    return { name, paths }
  })
}

function subsystemName(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > MAX_NAME_LENGTH ||
    /\p{Cc}/u.test(value)
  )
    throw new ArchitectureLayoutError(
      `"${field}" must be 1 to ${MAX_NAME_LENGTH} characters without surrounding spaces or control characters`,
    )
  const reserved = RESERVED_PREFIXES.find((prefix) => value.startsWith(prefix))
  if (reserved)
    throw new ArchitectureLayoutError(`"${field}" cannot start with "${reserved}"`)
  return value
}
