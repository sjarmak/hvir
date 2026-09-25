import { posix } from 'node:path'
import type { ArchitectureDiagnostic, ArchitectureSourceFile } from '../../shared'

/** A Cargo package: the directory of its Cargo.toml and the crate roots it builds. */
export interface RustPackage {
  readonly directory: string
  /** The name other crates `use` its library by, with `-` written as `_`. */
  readonly libraryName: string
  /** The library root, when the package has one among the scanned files. */
  readonly library?: string
  /** Every scanned crate root of the package, library first, in path order after it. */
  readonly roots: readonly string[]
}

interface Manifest {
  readonly directory: string
  readonly packageName?: string
  readonly libraryName?: string
  readonly libraryPath?: string
  readonly binaryPaths: readonly string[]
}

/**
 * The Cargo packages among the captured configs, rooted in the scanned Rust files. A
 * manifest without `[package]` is a workspace root and names no crate.
 */
export function rustPackages(
  configs: readonly ArchitectureSourceFile[],
  modules: ReadonlySet<string>,
): {
  readonly packages: readonly RustPackage[]
  readonly diagnostics: ArchitectureDiagnostic[]
} {
  const packages: RustPackage[] = []
  const diagnostics: ArchitectureDiagnostic[] = []
  for (const file of configs) {
    if (posix.basename(file.path) !== 'Cargo.toml') continue
    const manifest = readManifest(file)
    if (!manifest) continue
    if (!manifest.packageName)
      diagnostics.push({
        file: file.path,
        line: 1,
        message: 'This Cargo.toml [package] has no name, so its crate is not resolved.',
      })
    else packages.push(packageOf(manifest, manifest.packageName, modules))
  }
  return { packages, diagnostics }
}

function packageOf(
  manifest: Manifest,
  packageName: string,
  modules: ReadonlySet<string>,
): RustPackage {
  const at = (path: string) => posix.join(manifest.directory, path)
  const library = at(manifest.libraryPath ?? 'src/lib.rs')
  const conventional = [...modules].filter((path) =>
    isConventionalRoot(posix.relative(manifest.directory, path)),
  )
  const roots = new Set([
    ...[library, ...manifest.binaryPaths.map(at)].filter((path) => modules.has(path)),
    ...conventional.sort(),
  ])
  return {
    directory: manifest.directory,
    libraryName: (manifest.libraryName ?? packageName).replaceAll('-', '_'),
    ...(modules.has(library) ? { library } : {}),
    roots: [...roots],
  }
}

/** Cargo's target auto-discovery, relative to the package directory. */
const CONVENTIONAL_ROOT =
  /^(?:src\/main\.rs|build\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|(?:tests|benches|examples)\/[^/]+\.rs|examples\/[^/]+\/main\.rs)$/

const isConventionalRoot = (relative: string): boolean => CONVENTIONAL_ROOT.test(relative)

const KEY = String.raw`(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`
const TABLE = new RegExp(String.raw`^\[\[?\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*\]\]?$`)
const STRING_KEY = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/

/**
 * The few keys crate resolution needs, read line by line: `[package] name`, `[lib] name`
 * and `path`, and each `[[bin]] path`. Undefined for a workspace-only manifest.
 */
function readManifest(file: ArchitectureSourceFile): Manifest | undefined {
  let table = ''
  let hasPackage = false
  const values = new Map<string, string>()
  const binaryPaths: string[] = []
  for (const raw of file.content.split('\n')) {
    const line = withoutComment(raw).trim()
    const header = TABLE.exec(line)
    if (header) {
      table = tableName(header[1]!)
      hasPackage ||= table === 'package'
      continue
    }
    const entry = STRING_KEY.exec(line)
    if (!entry) continue
    const value = entry[2] ?? entry[3]!
    if (table === 'bin' && entry[1] === 'path') binaryPaths.push(value)
    else values.set(`${table}.${entry[1]}`, value)
  }
  if (!hasPackage) return undefined
  return {
    directory: posix.dirname(file.path),
    packageName: values.get('package.name'),
    libraryName: values.get('lib.name'),
    libraryPath: values.get('lib.path'),
    binaryPaths,
  }
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
