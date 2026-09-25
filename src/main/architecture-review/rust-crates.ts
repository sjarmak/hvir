import { posix } from 'node:path'
import type { ArchitectureDiagnostic, ArchitectureSourceFile } from '../../shared'
import { readCargoManifest, type CargoManifest } from './cargo-manifest'
import { crateRoots } from './rust-targets'

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
    const manifest = readCargoManifest(file)
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
  manifest: CargoManifest,
  packageName: string,
  modules: ReadonlySet<string>,
): RustPackage {
  return {
    directory: manifest.directory,
    libraryName: (manifest.libraryName ?? packageName).replaceAll('-', '_'),
    ...crateRoots(manifest, modules),
  }
}

/** The repository libraries by the name paths use them by, each with its package. */
export type RustLibraries = ReadonlyMap<string, readonly RustPackage[]>

/**
 * Every package with a scanned library, by library name. A name several packages build is
 * disclosed with each manifest, never settled by whichever manifest was read last.
 */
export function rustLibraries(packages: readonly RustPackage[]): {
  readonly libraries: RustLibraries
  readonly diagnostics: ArchitectureDiagnostic[]
} {
  const libraries = new Map<string, RustPackage[]>()
  const ordered = [...packages].sort((left, right) =>
    manifestOf(left).localeCompare(manifestOf(right)),
  )
  for (const entry of ordered)
    if (entry.library)
      libraries.set(entry.libraryName, [
        ...(libraries.get(entry.libraryName) ?? []),
        entry,
      ])
  const diagnostics = [...libraries]
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => ({
      file: manifestOf(owners[0]!),
      line: 1,
      message: `Several packages build a library named ${name} (${owners.map(manifestOf).join(', ')}), so a path through ${name} is unresolved outside those packages.`,
    }))
  return { libraries, diagnostics }
}

const manifestOf = (entry: RustPackage): string =>
  posix.join(entry.directory, 'Cargo.toml')
