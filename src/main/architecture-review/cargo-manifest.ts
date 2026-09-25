import { posix } from 'node:path'
import type { ArchitectureSourceFile } from '../../shared'

/** The Cargo target kinds a package may declare as arrays of tables, such as `[[test]]`. */
export type CargoTargetKind = 'bin' | 'example' | 'test' | 'bench'
export const CARGO_TARGET_KINDS: readonly CargoTargetKind[] = [
  'bin',
  'example',
  'test',
  'bench',
]

/** One `[[bin]]`, `[[example]]`, `[[test]]` or `[[bench]]` entry. */
export interface CargoTarget {
  readonly name?: string
  readonly path?: string
}

/** What crate resolution reads from a package's Cargo.toml. */
export interface CargoManifest {
  readonly directory: string
  readonly packageName?: string
  /** `[package] edition`; `inherited` for `edition.workspace = true`, absent when unset. */
  readonly edition?: string
  /** `[package] build`: a script path, or false for none. */
  readonly build?: string | boolean
  /** `[package] autolib`, `autobins`, `autoexamples`, `autotests` and `autobenches`. */
  readonly auto: Readonly<Partial<Record<CargoTargetKind | 'lib', boolean>>>
  readonly hasLibTable: boolean
  readonly libraryName?: string
  readonly libraryPath?: string
  /** The entries of each target array; absent for a kind the manifest declares none of. */
  readonly targets: Readonly<Partial<Record<CargoTargetKind, readonly CargoTarget[]>>>
}

const AUTO_FLAGS: Readonly<Record<string, CargoTargetKind | 'lib'>> = {
  autolib: 'lib',
  autobins: 'bin',
  autoexamples: 'example',
  autotests: 'test',
  autobenches: 'bench',
}

const KEY = String.raw`(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`
const TABLE = new RegExp(String.raw`^\[\[?\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*\]\]?$`)
const ENTRY =
  /^([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(true|false))$/

type Value = string | boolean

/**
 * The keys crate resolution needs, read line by line: the `[package]` name, edition, build
 * script and auto-discovery flags, `[lib]` name and path, and each target array entry's
 * name and path. Undefined for a workspace-only manifest.
 */
export function readCargoManifest(
  file: ArchitectureSourceFile,
): CargoManifest | undefined {
  let table = ''
  let hasPackage = false
  let hasLibTable = false
  const values = new Map<string, Value>()
  const targets: Partial<Record<CargoTargetKind, Record<string, Value>[]>> = {}
  for (const raw of file.content.split('\n')) {
    const line = withoutComment(raw).trim()
    const header = TABLE.exec(line)
    if (header) {
      table = tableName(header[1]!)
      hasPackage ||= table === 'package'
      hasLibTable ||= table === 'lib'
      const kind = targetKind(table)
      if (line.startsWith('[[') && kind) targets[kind] = [...(targets[kind] ?? []), {}]
      continue
    }
    const entry = ENTRY.exec(line)
    if (!entry) continue
    const key = entry[1]!.replace(/\s+/g, '')
    const value: Value =
      entry[4] === undefined ? (entry[2] ?? entry[3]!) : entry[4] === 'true'
    const kind = targetKind(table)
    const current = kind ? targets[kind]?.at(-1) : undefined
    if (current) current[key] = value
    else values.set(`${table}.${key}`, value)
  }
  if (!hasPackage) return undefined
  const text = (key: string) => {
    const value = values.get(key)
    return typeof value === 'string' ? value : undefined
  }
  return {
    directory: posix.dirname(file.path),
    packageName: text('package.name'),
    ...editionOf(values),
    ...(values.has('package.build') ? { build: values.get('package.build') } : {}),
    auto: Object.fromEntries(
      Object.entries(AUTO_FLAGS).flatMap(([flag, kind]) => {
        const value = values.get(`package.${flag}`)
        return typeof value === 'boolean' ? [[kind, value]] : []
      }),
    ),
    hasLibTable,
    libraryName: text('lib.name'),
    libraryPath: text('lib.path'),
    targets: Object.fromEntries(
      Object.entries(targets).map(([kind, entries]) => [
        kind,
        entries.map((entry) => ({
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
          ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
        })),
      ]),
    ),
  }
}

const targetKind = (table: string): CargoTargetKind | undefined =>
  (CARGO_TARGET_KINDS as readonly string[]).includes(table)
    ? (table as CargoTargetKind)
    : undefined

function editionOf(values: ReadonlyMap<string, Value>): { readonly edition?: string } {
  const edition = values.get('package.edition')
  if (typeof edition === 'string') return { edition }
  return values.get('package.edition.workspace') === true ? { edition: 'inherited' } : {}
}

/**
 * A dotted table key with its parts unquoted, so `[ "lib" ]` is `lib` and
 * `[target.'cfg(unix)'.dependencies]` is a table of its own rather than none.
 */
function tableName(key: string): string {
  const parts = key.match(new RegExp(KEY, 'g')) ?? []
  return parts.map((part) => part.replace(/^(["'])(.*)\1$/, '$2')).join('.')
}

/** Drops a `#` comment that is not inside a string. */
function withoutComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (quote) {
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") quote = character
    else if (character === '#') return line.slice(0, index)
  }
  return line
}
