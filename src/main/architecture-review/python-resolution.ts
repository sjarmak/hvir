import { posix } from 'node:path'
import type { ArchitectureImportFact } from '../../shared'
import type { ResolutionContext, ScanResolver } from './language-scanner'
import type { ModuleImportOccurrence } from './module-facts'

/**
 * Python resolution by path alone (ADR-063): a module is a `.py` file, a package is a
 * directory with `__init__.py`, and any directory holding modules is a namespace package.
 * An absolute import is looked up from the importing file's top-level package, then the
 * repository root, then `src`; a name found in none of them is external.
 */
export function pythonResolver({ modules }: ResolutionContext): ScanResolver {
  const index = moduleIndex([...modules.keys()])
  return {
    diagnostics: [],
    resolve: (source, occurrence) => resolvePython(index, source, occurrence),
  }
}

interface ModuleIndex {
  readonly files: ReadonlySet<string>
  readonly packages: ReadonlySet<string>
  readonly directories: ReadonlySet<string>
}

/** Where an import's module path is anchored, or why it cannot be. */
type Anchor =
  | { readonly base: string; readonly parts: readonly string[] }
  | { readonly resolution: 'external' | 'unresolved' }

function moduleIndex(paths: readonly string[]): ModuleIndex {
  const directories = new Set<string>()
  for (const path of paths)
    for (let directory = posix.dirname(path); !directories.has(directory);) {
      directories.add(directory)
      if (directory === '.') break
      directory = posix.dirname(directory)
    }
  const packages = paths
    .filter((path) => posix.basename(path) === '__init__.py')
    .map((path) => posix.dirname(path))
  return { files: new Set(paths), packages: new Set(packages), directories }
}

function resolvePython(
  index: ModuleIndex,
  source: string,
  occurrence: ModuleImportOccurrence,
): ArchitectureImportFact[] {
  const specifier = occurrence.specifier ?? ''
  const anchor = anchorOf(index, source, specifier)
  const fact = (name: string, target: string | undefined): ArchitectureImportFact => ({
    source,
    ...(target ? { target } : {}),
    specifier: name,
    form: occurrence.form,
    kind: occurrence.typeOnly ? 'type-only' : 'runtime',
    resolution: target
      ? 'internal'
      : 'resolution' in anchor
        ? anchor.resolution
        : 'unresolved',
    line: occurrence.line,
    column: occurrence.column,
  })
  if ('resolution' in anchor || occurrence.form !== 'from-import')
    return [
      fact(
        specifier,
        'base' in anchor ? moduleAt(index, anchor.base, anchor.parts) : undefined,
      ),
    ]
  const names = occurrence.names ?? []
  const submodules = names.flatMap((name) => {
    const target =
      name === '*' ? undefined : moduleAt(index, anchor.base, [...anchor.parts, name])
    return target ? [{ name, target }] : []
  })
  const facts = submodules.map(({ name, target }) =>
    fact(joinSpecifier(specifier, name), target),
  )
  return submodules.length === names.length
    ? facts
    : [...facts, fact(specifier, moduleAt(index, anchor.base, anchor.parts))]
}

const joinSpecifier = (specifier: string, name: string): string =>
  specifier.endsWith('.') ? `${specifier}${name}` : `${specifier}.${name}`

function anchorOf(index: ModuleIndex, source: string, specifier: string): Anchor {
  const level = /^\.*/.exec(specifier)![0].length
  const rest = specifier.slice(level)
  const parts = rest ? rest.split('.') : []
  if (level > 0) {
    let base = posix.dirname(source)
    for (let step = 1; step < level; step += 1) {
      if (base === '.') return { resolution: 'unresolved' }
      base = posix.dirname(base)
    }
    return { base, parts }
  }
  const head = parts[0]
  if (!head) return { resolution: 'unresolved' }
  const base = absoluteRoots(index, source).find(
    (root) =>
      index.files.has(posix.join(root, `${head}.py`)) ||
      index.directories.has(posix.join(root, head)),
  )
  return base === undefined ? { resolution: 'external' } : { base, parts }
}

/** The importing file's top-level package directory's parent, the repository root, `src`. */
function absoluteRoots(index: ModuleIndex, source: string): readonly string[] {
  let root = posix.dirname(source)
  while (root !== '.' && index.packages.has(root)) root = posix.dirname(root)
  return [...new Set([root, '.', 'src'])]
}

/** `pkg/mod.py` or `pkg/mod/__init__.py`; an empty path names the base package itself. */
function moduleAt(
  index: ModuleIndex,
  base: string,
  parts: readonly string[],
): string | undefined {
  const path = posix.join(base, ...parts)
  const file = `${path}.py`
  const initializer = posix.join(path, '__init__.py')
  if (parts.length > 0 && index.files.has(file)) return file
  return index.files.has(initializer) ? initializer : undefined
}
