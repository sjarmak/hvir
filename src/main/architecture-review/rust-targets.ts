import { posix } from 'node:path'
import {
  CARGO_TARGET_KINDS,
  type CargoManifest,
  type CargoTargetKind,
} from './cargo-manifest'

/** A package's scanned crate roots: its library, if any, and every root, library first. */
export interface CrateRoots {
  readonly library?: string
  readonly roots: readonly string[]
}

interface Target {
  readonly name: string
  /** Relative to the package directory. */
  readonly path: string
}

const DIRECTORIES: Readonly<Record<CargoTargetKind, string>> = {
  bin: 'src/bin',
  example: 'examples',
  test: 'tests',
  bench: 'benches',
}

/**
 * Cargo's targets for one package, among the scanned files (the Cargo book's "Target
 * auto-discovery"). Each kind is discovered from its directory, `<dir>/<name>.rs` and
 * `<dir>/<name>/main.rs`, with `src/main.rs` as the package's own binary, unless its auto
 * flag is false; in the 2015 edition, declaring any target of a kind also stops discovery of
 * that kind unless the flag says otherwise. A declared target without a path is found by
 * name among the discovered files, and a discovered target whose name or path a declared one
 * takes is left out. An inherited edition is taken as 2018 or later.
 */
export function crateRoots(
  manifest: CargoManifest,
  modules: ReadonlySet<string>,
): CrateRoots {
  const at = (path: string) => posix.join(manifest.directory, path)
  const relative = [...modules]
    .map((path) => posix.relative(manifest.directory, path))
    .filter((path) => !path.startsWith('../'))
  const library =
    manifest.hasLibTable || manifest.auto.lib !== false
      ? at(manifest.libraryPath ?? 'src/lib.rs')
      : undefined
  const targets = CARGO_TARGET_KINDS.flatMap((kind) =>
    targetsOf(manifest, kind, discovered(kind, relative, manifest.packageName ?? '')),
  )
  const roots = [...targets, ...buildScript(manifest)]
    .map(at)
    .filter((path) => path !== library && modules.has(path))
    .sort()
  const scannedLibrary = library && modules.has(library) ? library : undefined
  return {
    ...(scannedLibrary ? { library: scannedLibrary } : {}),
    roots: [...new Set([...(scannedLibrary ? [scannedLibrary] : []), ...roots])],
  }
}

function targetsOf(
  manifest: CargoManifest,
  kind: CargoTargetKind,
  inferred: readonly Target[],
): string[] {
  const declared = (manifest.targets[kind] ?? []).flatMap((target) => {
    const path = target.path ?? inferred.find((entry) => entry.name === target.name)?.path
    return path === undefined ? [] : [{ name: target.name, path: posix.normalize(path) }]
  })
  const edition2015 = manifest.edition === undefined || manifest.edition === '2015'
  const auto =
    manifest.auto[kind] ?? (manifest.targets[kind] === undefined || !edition2015)
  const rest = auto
    ? inferred.filter(
        (entry) =>
          !declared.some(
            (target) => target.name === entry.name || target.path === entry.path,
          ),
      )
    : []
  return [...declared, ...rest].map((target) => target.path)
}

function discovered(
  kind: CargoTargetKind,
  relative: readonly string[],
  packageName: string,
): Target[] {
  const directory = DIRECTORIES[kind]
  const found = relative.flatMap((path) => {
    if (posix.dirname(path) === directory && path.endsWith('.rs'))
      return [{ name: posix.basename(path, '.rs'), path }]
    const parent = posix.dirname(path)
    return posix.basename(path) === 'main.rs' && posix.dirname(parent) === directory
      ? [{ name: posix.basename(parent), path }]
      : []
  })
  return kind === 'bin' && relative.includes('src/main.rs')
    ? [{ name: packageName, path: 'src/main.rs' }, ...found]
    : found
}

/** `build = "path"` names the script, `build = false` turns it off, else `build.rs`. */
function buildScript(manifest: CargoManifest): string[] {
  if (manifest.build === false) return []
  return [typeof manifest.build === 'string' ? manifest.build : 'build.rs']
}
