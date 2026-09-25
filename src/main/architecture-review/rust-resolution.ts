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
  /** What each module provides, keyed by module; filled as modules are asked about. */
  private readonly provided = new Map<string, Provided>()
  /** Whether a module's `use` binding of a name leads somewhere, keyed by module and name. */
  private readonly bindings = new Map<string, boolean>()

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
            this.path(source, scope, leafPath(path).split('::'), NONE),
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

  /**
   * Where a path leads. `visiting` holds the `use` bindings already being followed, so a
   * binding that leads back to itself names nothing instead of counting as its own item.
   */
  private path(
    source: string,
    scope: readonly string[],
    segments: readonly string[],
    visiting: Visiting,
  ): Located {
    const here: RustModule = { file: source, scope }
    const [first = '', ...rest] = segments
    if (first === '') return this.inCrate(rest[0], rest.slice(1), visiting)
    if (first === 'crate') {
      const root = this.tree.rootOf(source)
      return root ? this.walk({ file: root, scope: [] }, rest, visiting) : UNRESOLVED
    }
    if (first === 'self' || first === 'super' || this.tree.child(here, first))
      return this.walk(here, segments, visiting)
    if (this.declaresMod(source, scope, first)) return UNRESOLVED
    if (this.crates.has(first)) return this.inCrate(first, rest, visiting)
    return this.providedBy(here)?.declared.has(first) ? internal(source) : EXTERNAL
  }

  private inCrate(
    name: string | undefined,
    rest: readonly string[],
    visiting: Visiting,
  ): Located {
    const library = name === undefined ? undefined : this.crates.get(name)
    return library ? this.walk({ file: library, scope: [] }, rest, visiting) : EXTERNAL
  }

  /**
   * Descends through child modules; the first segment that is not one names an item of the
   * module reached, file or inline, which that module must declare or bind.
   */
  private walk(
    start: RustModule,
    segments: readonly string[],
    visiting: Visiting,
  ): Located {
    let current: RustModule | undefined = start
    for (const segment of segments) {
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
      return this.provides(current, segment, visiting)
        ? internal(current.file)
        : UNRESOLVED
    }
    return internal(current.file)
  }

  /**
   * Whether a module declares an item by this name, or binds it through a `use` whose
   * own path leads somewhere; a glob `use p::*` binds the name when `p::name` leads somewhere.
   * A binding reached again while it is being followed names
   * nothing: rustc rejects `use self::x;` with no `x`, and two re-exports naming each other.
   */
  private provides(module: RustModule, name: string, visiting: Visiting): boolean {
    const provided = this.providedBy(module)
    if (!provided) return false
    if (provided.declared.has(name)) return true
    const key = `${moduleKey(module)}\u0000${name}`
    if (visiting.has(key)) return false
    const known = this.bindings.get(key)
    if (known !== undefined) return known
    const following = new Set([...visiting, key])
    const globbed = (provided.bound.get(GLOB) ?? []).map(
      (path) => `${path.slice(0, -GLOB.length)}${name}`,
    )
    const leads = [...(provided.bound.get(name) ?? []), ...globbed].some(
      (path) =>
        this.path(module.file, module.scope, path.split('::'), following).resolution !==
        'unresolved',
    )
    if (visiting.size === 0) this.bindings.set(key, leads)
    return leads
  }

  /** Whether a module declares `mod name;` in this scope, whatever file it resolves to. */
  private declaresMod(file: string, scope: readonly string[], name: string): boolean {
    return Boolean(
      this.facts
        .get(file)
        ?.imports.some(
          (entry) =>
            entry.form === 'mod' &&
            entry.specifier === name &&
            sameScope(entry.scope ?? [], scope),
        ),
    )
  }

  private providedBy(module: RustModule): Provided | undefined {
    const key = moduleKey(module)
    const known = this.provided.get(key)
    if (known) return known
    const facts = this.facts.get(module.file)
    if (!facts) return undefined
    const provided = providedIn(facts, module.scope)
    this.provided.set(key, provided)
    return provided
  }
}

const moduleKey = (module: RustModule): string =>
  [module.file, ...module.scope].join('\u0000')

const internal = (target: string): Located => ({ resolution: 'internal', target })

type Visiting = ReadonlySet<string>
const NONE: Visiting = new Set()

const sameScope = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

const ALIAS = ' as '

/** The path a use leaf names, without the `as` alias it binds. */
const leafPath = (leaf: string): string => leaf.split(ALIAS)[0]!

/**
 * The names a module makes available to paths through it: the items it declares, and each
 * name a `use` in that module binds with the paths bound to it; globs are bound to `*`.
 */
interface Provided {
  readonly declared: ReadonlySet<string>
  readonly bound: ReadonlyMap<string, readonly string[]>
}

const GLOB = '*'

function providedIn(facts: ModuleFacts, scope: readonly string[]): Provided {
  const leaves = facts.imports
    .filter((entry) => entry.form !== 'mod' && sameScope(entry.scope ?? [], scope))
    .flatMap((entry) => entry.names ?? [entry.specifier ?? ''])
  const bound = new Map<string, string[]>()
  for (const leaf of leaves) {
    const name = boundName(leaf)
    bound.set(name, [...(bound.get(name) ?? []), leafPath(leaf)])
  }
  const declared =
    scope.length === 0
      ? facts.symbols
      : (facts.inlineItems ?? []).filter((item) => sameScope(item.scope, scope))
  return { declared: new Set(declared.map((item) => item.name)), bound }
}

/** `a::b as c` binds `c`, `a::b` and `a::b::self` bind `b`, and `a::*` binds any name. */
function boundName(leaf: string): string {
  const [path = '', alias] = leaf.split(ALIAS)
  if (alias !== undefined) return alias
  const segments = path.split('::')
  return (segments.at(-1) === 'self' ? segments.at(-2) : segments.at(-1)) ?? ''
}
