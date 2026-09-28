import type { ArchitectureImportFact } from '../../shared'
import type { ResolutionContext, ScanResolver } from './language-scanner'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'

export function kotlinResolver({ modules, facts }: ResolutionContext): ScanResolver {
  const entries = [...modules.keys()].map((path) => ({ path, facts: facts.get(path)! }))
  const packages = new Set(entries.map(({ facts }) => facts.packageName ?? ''))
  return {
    diagnostics: [],
    resolve: (source, occurrence) => resolveKotlin(entries, packages, source, occurrence),
  }
}

interface KotlinEntry {
  readonly path: string
  readonly facts: ModuleFacts
}

function resolveKotlin(
  entries: readonly KotlinEntry[],
  packages: ReadonlySet<string>,
  source: string,
  occurrence: ModuleImportOccurrence,
): readonly ArchitectureImportFact[] {
  const specifier = occurrence.specifier ?? ''
  const wildcard = occurrence.names?.includes('*') ?? false
  const packageName = packages.has(specifier)
    ? specifier
    : packageOfImport(specifier, packages)
  const members = wildcard
    ? packages.has(specifier)
      ? []
      : [memberOfImport(specifier, packageName)]
    : [memberOfImport(specifier, packageName)]
  const candidates = entries.filter(
    ({ facts }) => (facts.packageName ?? '') === packageName,
  )
  const targets = wildcard
    ? candidates
    : candidates.filter(({ facts }) =>
        (facts.resolutionSymbols ?? facts.symbols.map(({ name }) => name)).includes(
          members[0]!,
        ),
      )
  const resolution =
    targets.length > 0
      ? 'internal'
      : packages.has(packageName)
        ? 'unresolved'
        : 'external'
  if (targets.length === 0) return [fact(source, occurrence, specifier, resolution)]
  return targets.map(({ path }) => fact(source, occurrence, specifier, 'internal', path))
}

function packageOfImport(specifier: string, packages: ReadonlySet<string>): string {
  const parts = specifier.split('.')
  for (let length = parts.length - 1; length >= 0; length -= 1) {
    const candidate = parts.slice(0, length).join('.')
    if (candidate && packages.has(candidate)) return candidate
  }
  return parts.slice(0, -1).join('.')
}

function memberOfImport(specifier: string, packageName: string): string {
  const prefix = packageName ? `${packageName}.` : ''
  return specifier.startsWith(prefix)
    ? specifier.slice(prefix.length).split('.')[0]!
    : specifier
}

function fact(
  source: string,
  occurrence: ModuleImportOccurrence,
  specifier: string,
  resolution: ArchitectureImportFact['resolution'],
  target?: string,
): ArchitectureImportFact {
  return {
    source,
    ...(target ? { target } : {}),
    specifier,
    form: occurrence.form,
    kind: 'runtime',
    resolution,
    line: occurrence.line,
    column: occurrence.column,
  }
}
