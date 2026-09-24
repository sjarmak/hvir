import { posix } from 'node:path'
import type {
  ArchitectureDiagnostic,
  ArchitectureImportFact,
  ArchitectureSourceFile,
} from '../../shared'
import type { ResolutionContext, ScanResolver } from './language-scanner'
import type { ModuleImportOccurrence } from './module-facts'

/**
 * Go resolution by module path (ADR-063): a Go module is a package directory. An import
 * whose path falls under the module path of a captured go.mod names the directory at the
 * same relative path under that go.mod, and is internal when that directory holds Go files
 * of the same module. Every other import (the standard library, third-party modules, cgo's
 * `C`) is external.
 */
export function goResolver({ modules, configs }: ResolutionContext): ScanResolver {
  const goMods = configs.filter((file) => posix.basename(file.path) === 'go.mod')
  const declared = goMods.map(declaredModule)
  const roots = declared.flatMap((entry) => ('root' in entry ? [entry.root] : []))
  const index: GoIndex = {
    roots,
    boundaries: goMods.map((file) => posix.dirname(file.path)),
    packages: new Set([...modules.keys()].map((path) => posix.dirname(path))),
  }
  return {
    diagnostics: [
      ...declared.flatMap((entry) => ('diagnostic' in entry ? [entry.diagnostic] : [])),
      ...(goMods.length === 0 ? [NO_GO_MOD] : []),
    ],
    resolve: (source, occurrence) => [resolveGo(index, source, occurrence)],
  }
}

/** A module path declared by one go.mod, and the repository directory it is rooted at. */
interface ModuleRoot {
  readonly modulePath: string
  readonly directory: string
}

interface GoIndex {
  readonly roots: readonly ModuleRoot[]
  /** Directories holding a go.mod: each starts a module, named or not. */
  readonly boundaries: readonly string[]
  /** Directories holding at least one scanned Go file. */
  readonly packages: ReadonlySet<string>
}

const NO_GO_MOD: ArchitectureDiagnostic = {
  file: '(capture)',
  line: 1,
  message:
    'No go.mod was captured, so no Go import can be matched to a package in this repository; every Go import is classified as external.',
}

const MODULE_DIRECTIVE = /^\s*module\s+("[^"]+"|`[^`]+`|\S+)/

function declaredModule(
  file: ArchitectureSourceFile,
): { readonly root: ModuleRoot } | { readonly diagnostic: ArchitectureDiagnostic } {
  const lines = file.content.split('\n').map((line) => line.replace(/\/\/.*$/, ''))
  const match = lines.map((line) => MODULE_DIRECTIVE.exec(line)).find(Boolean)
  if (!match)
    return {
      diagnostic: {
        file: file.path,
        line: 1,
        message:
          'This go.mod names no module, so imports of its packages are not matched.',
      },
    }
  const quoted = /^["`]/.test(match[1]!)
  return {
    root: {
      modulePath: quoted ? match[1]!.slice(1, -1) : match[1]!,
      directory: posix.dirname(file.path),
    },
  }
}

function resolveGo(
  index: GoIndex,
  source: string,
  occurrence: ModuleImportOccurrence,
): ArchitectureImportFact {
  const specifier = occurrence.specifier ?? ''
  const located = packageDirectory(index, specifier)
  return {
    source,
    ...(located.target ? { target: located.target } : {}),
    specifier,
    form: occurrence.form,
    kind: occurrence.typeOnly ? 'type-only' : 'runtime',
    resolution: located.resolution,
    line: occurrence.line,
    column: occurrence.column,
  }
}

/**
 * The longest module path that covers the import decides where it lives. A directory that
 * belongs to a nested go.mod is another module's package, so it does not match.
 */
function packageDirectory(
  index: GoIndex,
  specifier: string,
): {
  readonly resolution: ArchitectureImportFact['resolution']
  readonly target?: string
} {
  const root = longest(
    index.roots.filter(
      ({ modulePath }) =>
        specifier === modulePath || specifier.startsWith(`${modulePath}/`),
    ),
    (entry) => entry.modulePath,
  )
  if (!root) return { resolution: 'external' }
  const rest = specifier.slice(root.modulePath.length)
  if (rest.split('/').some((part) => part === '.' || part === '..'))
    return { resolution: 'unresolved' }
  const target = posix.join(root.directory, rest)
  const owner = longest(
    index.boundaries.filter((boundary) => covers(boundary, target)),
    (boundary) => (boundary === '.' ? '' : boundary),
  )
  return index.packages.has(target) && owner === root.directory
    ? { resolution: 'internal', target }
    : { resolution: 'unresolved' }
}

const covers = (directory: string, path: string): boolean =>
  directory === '.' || path === directory || path.startsWith(`${directory}/`)

function longest<T>(entries: readonly T[], key: (entry: T) => string): T | undefined {
  return entries.reduce<T | undefined>(
    (best, entry) => (!best || key(entry).length > key(best).length ? entry : best),
    undefined,
  )
}
