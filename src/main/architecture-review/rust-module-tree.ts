import { posix } from 'node:path'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'
import type { RustPackage } from './rust-crates'

/** A Rust module: a file, or an inline `mod a { ... }` inside it, named by its path. */
export interface RustModule {
  readonly file: string
  readonly scope: readonly string[]
}

interface Placement {
  readonly root: string
  /** The module whose `mod` declaration loads this file; absent for a crate root. */
  readonly parent?: RustModule
  /**
   * Whether its own `mod name;` files sit beside it: a crate root, a `mod.rs`, or a file
   * loaded through `#[path]`, which rustc treats as a mod-rs file wherever it points.
   */
  readonly modRs: boolean
}

const scopeKey = (scope: readonly string[]): string => scope.join('::')
const MOD_RS_NAMES: ReadonlySet<string> = new Set(['mod.rs', 'lib.rs', 'main.rs'])

/**
 * The module tree of every crate, grown from each crate root through its `mod`
 * declarations. A file reached from several roots keeps the first, in package and root
 * order; a file no root reaches is outside every tree.
 */
export class RustModuleTree {
  private readonly placements = new Map<string, Placement>()
  /** Per file: `mod` declarations by the inline scope they sit in, then by name. */
  private readonly declarations = new Map<
    string,
    ReadonlyMap<string, ReadonlyMap<string, ModuleImportOccurrence>>
  >()
  /** Per file: the inline modules it holds, by scope key. */
  private readonly inline = new Map<string, ReadonlySet<string>>()

  constructor(
    facts: ReadonlyMap<string, ModuleFacts>,
    private readonly files: ReadonlySet<string>,
    packages: readonly RustPackage[],
  ) {
    for (const [file, parsed] of facts) this.index(file, parsed)
    const ordered = [...packages].sort((left, right) =>
      left.directory.localeCompare(right.directory),
    )
    for (const entry of ordered) for (const root of entry.roots) this.grow(root)
  }

  reaches(file: string): boolean {
    return this.placements.has(file)
  }

  rootOf(file: string): string | undefined {
    return this.placements.get(file)?.root
  }

  parent(module: RustModule): RustModule | undefined {
    if (module.scope.length > 0)
      return { file: module.file, scope: module.scope.slice(0, -1) }
    return this.placements.get(module.file)?.parent
  }

  /** A child module by name: a file its `mod` declaration loads, or an inline module. */
  child(module: RustModule, name: string): RustModule | undefined {
    const declaration = this.declarations
      .get(module.file)
      ?.get(scopeKey(module.scope))
      ?.get(name)
    const file = declaration && this.declaredFile(module.file, module.scope, declaration)
    if (file) return { file, scope: [] }
    const scope = [...module.scope, name]
    return this.inline.get(module.file)?.has(scopeKey(scope))
      ? { file: module.file, scope }
      : undefined
  }

  /**
   * The file a `mod name;` loads (the Rust reference's rules): beside a mod-rs file, in a
   * directory named after any other file, under the inline modules around it, or where a
   * `#[path]` attribute points relative to the declaring file's directory.
   */
  declaredFile(
    file: string,
    scope: readonly string[],
    declaration: ModuleImportOccurrence,
  ): string | undefined {
    const directory = posix.dirname(file)
    const own = this.isModRs(file)
      ? directory
      : posix.join(directory, posix.basename(file, '.rs'))
    const candidates =
      declaration.pathAttribute !== undefined
        ? [
            posix.join(
              scope.length === 0 ? directory : posix.join(own, ...scope),
              declaration.pathAttribute,
            ),
          ]
        : [
            posix.join(own, ...scope, `${declaration.specifier}.rs`),
            posix.join(own, ...scope, declaration.specifier ?? '', 'mod.rs'),
          ]
    return candidates.find((path) => !path.startsWith('../') && this.files.has(path))
  }

  private isModRs(file: string): boolean {
    return this.placements.get(file)?.modRs ?? MOD_RS_NAMES.has(posix.basename(file))
  }

  private index(file: string, facts: ModuleFacts): void {
    const byScope = new Map<string, Map<string, ModuleImportOccurrence>>()
    const inline = new Set([
      ...facts.symbols
        .filter((symbol) => symbol.kind === 'module')
        .map((symbol) => symbol.name),
      ...(facts.inlineItems ?? [])
        .filter((item) => item.kind === 'module')
        .map((item) => scopeKey([...item.scope, item.name])),
    ])
    for (const occurrence of facts.imports) {
      // A declaration inside a block belongs to no module a path can name.
      if (occurrence.local) continue
      const scope = occurrence.scope ?? []
      scope.forEach((_, index) => inline.add(scopeKey(scope.slice(0, index + 1))))
      if (occurrence.form !== 'mod' || occurrence.specifier === undefined) continue
      const named =
        byScope.get(scopeKey(scope)) ?? new Map<string, ModuleImportOccurrence>()
      if (!named.has(occurrence.specifier)) named.set(occurrence.specifier, occurrence)
      byScope.set(scopeKey(scope), named)
    }
    this.declarations.set(file, byScope)
    this.inline.set(file, inline)
  }

  /** Breadth-first from one crate root; files already placed keep their first placement. */
  private grow(root: string): void {
    if (this.placements.has(root)) return
    this.placements.set(root, { root, modRs: true })
    const queue = [root]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const [key, named] of this.declarations.get(next) ?? []) {
        const scope = key === '' ? [] : key.split('::')
        for (const declaration of named.values()) {
          const child = this.declaredFile(next, scope, declaration)
          if (!child || this.placements.has(child)) continue
          this.placements.set(child, {
            root,
            parent: { file: next, scope },
            modRs:
              declaration.pathAttribute !== undefined ||
              posix.basename(child) === 'mod.rs',
          })
          queue.push(child)
        }
      }
    }
  }
}
