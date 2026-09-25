import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  ARCHITECTURE_ANALYSIS_LIMITS,
  ARCHITECTURE_DEFAULT_LAYOUT,
  subsystemOf,
} from '../../shared'
import type {
  ArchitectureDiagnostic,
  ArchitectureAnalysis,
  ArchitectureChange,
  ArchitectureImportDelta,
  ArchitectureImportFact,
  ArchitectureLayout,
  ArchitectureModule,
  ArchitectureModuleDelta,
  ArchitectureScanInput,
  ArchitectureScanResult,
  ArchitectureSourceFile,
} from '../../shared'
import { gitBlobId } from './blob-id'
import type { LanguageScanner, ScannerSet, ScanResolver } from './language-scanner'
import type { ModuleFacts } from './module-facts'
import { TYPESCRIPT_ONLY_SCANNERS } from './typescript-scanner'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const blobHash = (file: ArchitectureSourceFile): string =>
  file.object ?? gitBlobId(Buffer.from(file.content, 'utf8'))

/** Supplies one module's facts; the default parses it, a cached source may not need to. */
export type ModuleFactsSource = (source: {
  readonly path: string
  readonly content: string
  /** Git's blob id for `content`. */
  readonly blob: string
  readonly scanner: LanguageScanner
  /** The scanner's parse kind for this path, such as `.tsx` or `.py`. */
  readonly kind: string
}) => ModuleFacts

const parseWithScanner: ModuleFactsSource = ({ path, content, scanner }) =>
  scanner.parse(path, content)

interface ScanModule {
  readonly source: ArchitectureSourceFile
  readonly scanner: LanguageScanner
  readonly kind: string
}

interface ParsedModule extends ScanModule {
  readonly blob: string
  readonly facts: ModuleFacts
}

/**
 * Parses every captured file a loaded scanner claims, then resolves its imports against the
 * other modules of the same language and what they parsed to. Files no scanner reads are
 * disclosed, not dropped.
 */
export function scanArchitecture(
  input: ArchitectureScanInput,
  scanners: ScannerSet = TYPESCRIPT_ONLY_SCANNERS,
  factsOf: ModuleFactsSource = parseWithScanner,
): ArchitectureScanResult {
  if (!input.scope.trim()) throw new Error('Architecture scan scope is required')
  const sorted = [...input.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const configs = input.configs ?? []
  const layout = input.layout ?? ARCHITECTURE_DEFAULT_LAYOUT
  const claimed = claimModules(sorted, scanners).map((entry) =>
    parseModule(entry, factsOf),
  )
  const resolvers = languageResolvers(claimed, configs)
  const modules: ArchitectureModule[] = []
  const imports: ArchitectureImportFact[] = []
  const diagnostics: ArchitectureDiagnostic[] = [
    ...[...resolvers.values()].flatMap((resolver) => resolver.diagnostics),
    ...unscannedDiagnostics(sorted.length - claimed.length),
  ]
  for (const entry of claimed) {
    const scanned = scanModule(entry, resolvers.get(entry.scanner)!, layout)
    diagnostics.push(...scanned.diagnostics)
    modules.push(scanned.module)
    imports.push(
      ...scanned.imports.slice(
        0,
        Math.max(0, ARCHITECTURE_ANALYSIS_LIMITS.maxImports - imports.length),
      ),
    )
  }
  if (imports.length === ARCHITECTURE_ANALYSIS_LIMITS.maxImports)
    diagnostics.push({
      file: '(capture)',
      line: 1,
      message: 'Import evidence was truncated at the analysis limit.',
    })
  return {
    fingerprint: scanFingerprint(input, sorted, configs),
    scope: input.scope,
    exclusions: [...input.exclusions],
    modules,
    imports,
    diagnostics,
  }
}

function claimModules(
  sources: readonly ArchitectureSourceFile[],
  scanners: ScannerSet,
): readonly ScanModule[] {
  return sources.flatMap((source) => {
    const match = scanners.scannerFor(source.path)
    return match ? [{ source, scanner: match.scanner, kind: match.kind }] : []
  })
}

function parseModule(entry: ScanModule, factsOf: ModuleFactsSource): ParsedModule {
  const { source, scanner, kind } = entry
  const blob = blobHash(source)
  const facts = factsOf({
    path: source.path,
    content: source.content,
    blob,
    scanner,
    kind,
  })
  return { ...entry, blob, facts }
}

/** One resolver per language present, each seeing only that language's modules. */
function languageResolvers(
  parsed: readonly ParsedModule[],
  configs: readonly ArchitectureSourceFile[],
): ReadonlyMap<LanguageScanner, ScanResolver> {
  const byScanner = new Map<LanguageScanner, ParsedModule[]>()
  for (const entry of parsed) {
    const entries = byScanner.get(entry.scanner) ?? []
    entries.push(entry)
    byScanner.set(entry.scanner, entries)
  }
  return new Map(
    [...byScanner].map(([scanner, entries]) => [
      scanner,
      scanner.resolver({
        modules: new Map(entries.map(({ source }) => [source.path, source.content])),
        facts: new Map(entries.map(({ source, facts }) => [source.path, facts])),
        configs,
      }),
    ]),
  )
}

function unscannedDiagnostics(count: number): readonly ArchitectureDiagnostic[] {
  return count === 0
    ? []
    : [
        {
          file: '(capture)',
          line: 1,
          message: `${count} captured source file(s) have no loaded scanner and were not scanned.`,
        },
      ]
}

/** Identity by path and blob id: the ids already name every byte of every input. */
function scanFingerprint(
  input: ArchitectureScanInput,
  sources: readonly ArchitectureSourceFile[],
  configs: readonly ArchitectureSourceFile[],
): string {
  const ids = (files: readonly ArchitectureSourceFile[]) =>
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => [file.path, blobHash(file)])
  return digest(
    JSON.stringify({
      scope: input.scope,
      exclusions: [...input.exclusions],
      layout: input.layout ?? ARCHITECTURE_DEFAULT_LAYOUT,
      configs: ids(configs),
      files: ids(sources),
    }),
  )
}

function scanModule(
  { source, blob, facts }: ParsedModule,
  resolver: ScanResolver,
  layout: ArchitectureLayout,
): {
  module: ArchitectureModule
  imports: readonly ArchitectureImportFact[]
  diagnostics: readonly ArchitectureDiagnostic[]
} {
  return {
    module: {
      path: source.path,
      subsystem: subsystemOf(layout, source.path),
      hash: blob,
      symbols: facts.symbols,
    },
    imports: facts.imports.flatMap((occurrence) =>
      resolver.resolve(source.path, occurrence),
    ),
    diagnostics: facts.diagnostics.map((entry) => ({ file: source.path, ...entry })),
  }
}

const importKey = (fact: ArchitectureImportFact): string =>
  JSON.stringify([
    fact.source,
    fact.target ?? null,
    fact.specifier,
    fact.form,
    fact.kind,
    fact.resolution,
  ])

function change(before: boolean, after: boolean, modified: boolean): ArchitectureChange {
  return !before ? 'added' : !after ? 'removed' : modified ? 'changed' : 'unchanged'
}

export function compareArchitecture(
  before: ArchitectureScanResult,
  after: ArchitectureScanResult,
): ArchitectureAnalysis {
  const oldModules = new Map(before.modules.map((module) => [module.path, module]))
  const newModules = new Map(after.modules.map((module) => [module.path, module]))
  const modules: ArchitectureModuleDelta[] = [
    ...new Set([...oldModules.keys(), ...newModules.keys()]),
  ]
    .sort()
    .map((path) => {
      const old = oldModules.get(path),
        current = newModules.get(path)
      return {
        ...(current ?? old!),
        change: change(
          Boolean(old),
          Boolean(current),
          Boolean(old && current && old.hash !== current.hash),
        ),
      }
    })
  const occurrences = (facts: readonly ArchitectureImportFact[]) => {
    const counts = new Map<string, number>()
    return new Map(
      facts.map((fact) => {
        const base = importKey(fact)
        const occurrence = counts.get(base) ?? 0
        counts.set(base, occurrence + 1)
        return [`${base}:${occurrence}`, fact] as const
      }),
    )
  }
  const oldImports = occurrences(before.imports)
  const newImports = occurrences(after.imports)
  const imports: ArchitectureImportDelta[] = [
    ...new Set([...oldImports.keys(), ...newImports.keys()]),
  ]
    .sort()
    .map((key) => {
      const old = oldImports.get(key)
      const current = newImports.get(key) ?? old!
      return {
        ...current,
        change: change(Boolean(old), Boolean(newImports.get(key)), false),
        ...(old && current.line !== old.line
          ? { beforeLine: old.line, beforeColumn: old.column }
          : {}),
      }
    })
  const subsystemOfModule = subsystemLookup(before, after)
  const pairs = new Map<string, ArchitectureImportDelta[]>()
  for (const fact of imports) {
    const target = fact.target
      ? subsystemOfModule(fact.target)
      : `${fact.resolution}: ${fact.specifier}`
    const source = subsystemOfModule(fact.source)
    if (source === target) continue
    const key = JSON.stringify([source, target])
    pairs.set(key, [...(pairs.get(key) ?? []), fact])
  }
  const relationships = [...pairs]
    .map(([key, evidence]) => {
      const [source, target] = JSON.parse(key) as [string, string]
      const beforeCount = evidence.filter((fact) => fact.change !== 'added').length
      const afterCount = evidence.filter((fact) => fact.change !== 'removed').length
      return {
        source,
        target,
        before: beforeCount,
        after: afterCount,
        change: change(
          beforeCount > 0,
          afterCount > 0,
          evidence.some((fact) => fact.change !== 'unchanged'),
        ),
        evidence,
      }
    })
    .sort((left, right) =>
      `${left.source}\0${left.target}`.localeCompare(`${right.source}\0${right.target}`),
    )
  return { before, after, modules, imports, relationships }
}

/**
 * A subsystem by module path, Current first. A Go import targets a package directory, which
 * takes the subsystem of its first scanned file in path order.
 */
function subsystemLookup(
  before: ArchitectureScanResult,
  after: ArchitectureScanResult,
): (path: string) => string {
  const byPath = new Map<string, string>()
  const byDirectory = new Map<string, string>()
  for (const module of [...after.modules, ...before.modules]) {
    if (!byPath.has(module.path)) byPath.set(module.path, module.subsystem)
    const directory = posix.dirname(module.path)
    if (!byDirectory.has(directory)) byDirectory.set(directory, module.subsystem)
  }
  return (path) => {
    const subsystem = byPath.get(path) ?? byDirectory.get(path)
    if (subsystem === undefined)
      throw new Error(`Import evidence names an unscanned module: ${path}`)
    return subsystem
  }
}

export function analyzeArchitecture(
  before: ArchitectureScanInput,
  after: ArchitectureScanInput,
  scanners: ScannerSet = TYPESCRIPT_ONLY_SCANNERS,
): ArchitectureAnalysis {
  return compareArchitecture(
    scanArchitecture(before, scanners),
    scanArchitecture(after, scanners),
  )
}
