import type { ArchitectureDiagnostic, ArchitectureImportFact } from '../../shared'
import type { ResolutionContext, ScanResolver } from './language-scanner'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'
import { rustPackages } from './rust-crates'
import { RustModuleTree, type RustModule } from './rust-module-tree'

/**
 * Rust resolution within the crate tree (ADR-063): a Rust module is a file within its crate.
 * Each captured Cargo package's crate roots are followed through their `mod` declarations,
 * so `crate::`, `self::` and `super::` paths walk the real module tree, `#[path]` included.
 * A path that starts with a repository crate's library name walks that crate; every other
 * extern crate is external.
 */
export function rustResolver({
  modules,
  facts,
  configs,
}: ResolutionContext): ScanResolver {
  const files = new Set(modules.keys())
  const { packages, diagnostics } = rustPackages(configs, files)
  const tree = new RustModuleTree(facts, files, packages)
  const crates = new Map(
    packages.flatMap((entry) =>
      entry.library ? [[entry.libraryName, entry.library] as const] : [],
    ),
  )
  const resolver = new PathResolver(tree, crates, facts)
  return {
    diagnostics: [
      ...diagnostics,
      ...(packages.length === 0 ? [NO_PACKAGE] : unreached(tree, [...files].sort())),
    ],
    resolve: (source, occurrence) => resolver.resolve(source, occurrence),
  }
}

const NO_PACKAGE: ArchitectureDiagnostic = {
  file: '(capture)',
  line: 1,
  message:
    'No Cargo.toml with a [package] was captured, so no Rust file is placed in a crate; crate paths are unresolved and every other path is classified as external.',
}

function unreached(
  tree: RustModuleTree,
  files: readonly string[],
): readonly ArchitectureDiagnostic[] {
  return files
    .filter((file) => !tree.reaches(file))
    .map((file) => ({
      file,
      line: 1,
      message:
        'No crate root reaches this file through mod declarations, so its crate and super paths are unresolved.',
    }))
}

type Located = {
  readonly resolution: ArchitectureImportFact['resolution']
  readonly target?: string
}
const UNRESOLVED: Located = { resolution: 'unresolved' }
const EXTERNAL: Located = { resolution: 'external' }

class PathResolver {
  constructor(
    private readonly tree: RustModuleTree,
    private readonly crates: ReadonlyMap<string, string>,
    private readonly facts: ReadonlyMap<string, ModuleFacts>,
  ) {}

  /** One fact per distinct place a declaration names, in the order its paths name them. */
  resolve(source: string, occurrence: ModuleImportOccurrence): ArchitectureImportFact[] {
    const scope = occurrence.scope ?? []
    const located =
      occurrence.form === 'mod'
        ? [this.declared(source, scope, occurrence)]
        : (occurrence.names ?? [occurrence.specifier ?? '']).map((path) =>
            this.path(source, scope, path.split('::')),
          )
    const distinct = new Map(
      located.map((entry) => [`${entry.resolution}:${entry.target}`, entry]),
    )
    return [...distinct.values()].map((entry) => ({
      source,
      ...(entry.target ? { target: entry.target } : {}),
      specifier: occurrence.specifier ?? '',
      form: occurrence.form,
      kind: 'runtime',
      resolution: entry.resolution,
      line: occurrence.line,
      column: occurrence.column,
    }))
  }

  private declared(
    source: string,
    scope: readonly string[],
    occurrence: ModuleImportOccurrence,
  ): Located {
    const file = this.tree.declaredFile(source, scope, occurrence)
    return file ? { resolution: 'internal', target: file } : UNRESOLVED
  }

  private path(source: string, scope: readonly string[], segments: string[]): Located {
    const here: RustModule = { file: source, scope }
    const [first = '', ...rest] = segments
    if (first === '') return this.inCrate(rest[0], rest.slice(1))
    if (first === 'crate') {
      const root = this.tree.rootOf(source)
      return root ? this.walk({ file: root, scope: [] }, rest) : UNRESOLVED
    }
    if (first === 'self' || first === 'super' || this.tree.child(here, first))
      return this.walk(here, segments)
    if (this.crates.has(first)) return this.inCrate(first, rest)
    return scope.length === 0 && this.declares(source, first)
      ? internal(source)
      : EXTERNAL
  }

  private inCrate(name: string | undefined, rest: readonly string[]): Located {
    const library = name === undefined ? undefined : this.crates.get(name)
    return library ? this.walk({ file: library, scope: [] }, rest) : EXTERNAL
  }

  /**
   * Descends through child modules; the first segment that is not one names an item of the
   * module reached, which must be the last segment or a declared item such as an enum.
   */
  private walk(start: RustModule, segments: readonly string[]): Located {
    let current: RustModule | undefined = start
    for (const [index, segment] of segments.entries()) {
      if (segment === 'self') continue
      if (segment === '*') break
      if (segment === 'super') {
        current = this.tree.parent(current)
        if (!current) return UNRESOLVED
        continue
      }
      const child = this.tree.child(current, segment)
      if (child) {
        current = child
        continue
      }
      const last = segments
        .slice(index + 1)
        .every((rest) => rest === '*' || rest === 'self')
      return last || current.scope.length > 0 || this.declares(current.file, segment)
        ? internal(current.file)
        : UNRESOLVED
    }
    return internal(current.file)
  }

  private declares(file: string, name: string): boolean {
    return Boolean(this.facts.get(file)?.symbols.some((symbol) => symbol.name === name))
  }
}

const internal = (target: string): Located => ({ resolution: 'internal', target })
