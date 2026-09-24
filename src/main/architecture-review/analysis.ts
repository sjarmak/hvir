import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import ts from 'typescript'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type {
  ArchitectureDiagnostic,
  ArchitectureAnalysis,
  ArchitectureChange,
  ArchitectureImportDelta,
  ArchitectureImportFact,
  ArchitectureModule,
  ArchitectureModuleDelta,
  ArchitectureScanInput,
  ArchitectureScanResult,
  ArchitectureSourceFile,
} from '../../shared'
import { gitBlobId } from './blob-id'
import {
  parseModuleFacts,
  type ModuleFacts,
  type ModuleImportOccurrence,
} from './module-facts'
import {
  loadCompilerSettings,
  VIRTUAL_ROOT,
  type CompilerSettings,
} from './compiler-config'

const implementation = /\.[cm]?[jt]sx?$/
/** Whether a captured file is a module the scan parses, rather than only reads. */
export const isArchitectureModule = (path: string): boolean => implementation.test(path)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const blobHash = (file: ArchitectureSourceFile): string =>
  file.object ?? gitBlobId(Buffer.from(file.content, 'utf8'))

function group(path: string): string {
  const directory = posix.dirname(path)
  return directory === '.' ? '(repository root)' : directory
}

/** Resolves one import as written against this scan's files and compiler options. */
function resolveImport(
  source: string,
  occurrence: ModuleImportOccurrence,
  options: ts.CompilerOptions,
  files: ReadonlyMap<string, string>,
  resolver: ModuleResolver,
  cache: ts.ModuleResolutionCache,
): ArchitectureImportFact {
  const literal = occurrence.specifier
  const resolved = !literal
    ? undefined
    : ts.resolveModuleName(
        literal,
        posix.join(VIRTUAL_ROOT, source),
        options,
        resolver.host,
        cache,
      ).resolvedModule
  const target = resolved
    ? posix.relative(VIRTUAL_ROOT, resolved.resolvedFileName)
    : undefined
  const resolution: ArchitectureImportFact['resolution'] =
    target && files.has(target)
      ? 'internal'
      : literal && (literal.startsWith('node:') || !isLocal(literal, options))
        ? 'external'
        : 'unresolved'
  return {
    source,
    ...(resolution === 'internal' ? { target } : {}),
    specifier: literal ?? '<computed>',
    form: occurrence.form,
    kind: occurrence.typeOnly ? 'type-only' : 'runtime',
    resolution,
    line: occurrence.line,
    column: occurrence.column,
  }
}

function isLocal(literal: string, options: ts.CompilerOptions): boolean {
  return (
    literal.startsWith('.') ||
    literal.startsWith('/') ||
    literal.startsWith('#') ||
    Object.keys(options.paths ?? {}).some((pattern) => {
      const [prefix, suffix] = pattern.split('*')
      return suffix === undefined
        ? literal === prefix
        : literal.startsWith(prefix ?? '') && literal.endsWith(suffix ?? '')
    }) ||
    Boolean(options.baseUrl && !literal.startsWith('node:'))
  )
}

/** Supplies one module's facts; the default parses it, a cached source may not need to. */
export type ModuleFactsSource = (source: {
  readonly path: string
  readonly content: string
  /** Git's blob id for `content`. */
  readonly blob: string
}) => ModuleFacts

export const parseFacts: ModuleFactsSource = ({ path, content }) =>
  parseModuleFacts(path, content)

export function scanArchitecture(
  input: ArchitectureScanInput,
  factsOf: ModuleFactsSource = parseFacts,
): ArchitectureScanResult {
  if (!input.scope.trim()) throw new Error('Architecture scan scope is required')
  const sorted = [...input.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const configs = input.configs ?? []
  const files = new Map(sorted.map((file) => [file.path, file.content]))
  const settings = loadCompilerSettings(configs, [...files.keys()])
  const resolver = moduleResolver(files, configs, settings)
  const modules: ArchitectureModule[] = []
  const imports: ArchitectureImportFact[] = []
  const diagnostics: ArchitectureDiagnostic[] = [...settings.diagnostics]
  for (const source of sorted) {
    if (!isArchitectureModule(source.path)) continue
    const scanned = scanModule(source, resolver, files, factsOf)
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
      configs: ids(configs),
      files: ids(sources),
    }),
  )
}

interface ModuleResolver {
  readonly host: ts.ModuleResolutionHost
  readonly settings: CompilerSettings
  readonly cacheFor: (
    config: string | undefined,
    options: ts.CompilerOptions,
  ) => ts.ModuleResolutionCache
}

/** Resolution sees every captured source and config, and caches per governing project. */
function moduleResolver(
  files: ReadonlyMap<string, string>,
  configs: readonly ArchitectureSourceFile[],
  settings: CompilerSettings,
): ModuleResolver {
  const readable = new Map([
    ...configs.map((file) => [file.path, file.content] as const),
    ...files,
  ])
  const directories = new Set<string>(['', '.'])
  for (const path of readable.keys()) {
    let directory = posix.dirname(path)
    while (!directories.has(directory)) {
      directories.add(directory)
      directory = posix.dirname(directory)
    }
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => readable.has(posix.relative(VIRTUAL_ROOT, path)),
    readFile: (path) => readable.get(posix.relative(VIRTUAL_ROOT, path)),
    directoryExists: (path) => directories.has(posix.relative(VIRTUAL_ROOT, path)),
    getCurrentDirectory: () => VIRTUAL_ROOT,
  }
  const caches = new Map<string | undefined, ts.ModuleResolutionCache>()
  const cacheFor = (config: string | undefined, options: ts.CompilerOptions) => {
    const known = caches.get(config)
    if (known) return known
    const cache = ts.createModuleResolutionCache(VIRTUAL_ROOT, (path) => path, options)
    caches.set(config, cache)
    return cache
  }
  return { host, settings, cacheFor }
}

function scanModule(
  source: ArchitectureSourceFile,
  resolver: ModuleResolver,
  files: ReadonlyMap<string, string>,
  factsOf: ModuleFactsSource,
): {
  module: ArchitectureModule
  imports: readonly ArchitectureImportFact[]
  diagnostics: readonly ArchitectureDiagnostic[]
} {
  const blob = blobHash(source)
  const facts = factsOf({ path: source.path, content: source.content, blob })
  const project = resolver.settings.projectFor(source.path)
  const cache = resolver.cacheFor(project.config, project.options)
  return {
    module: {
      path: source.path,
      group: group(source.path),
      hash: blob,
      symbols: facts.symbols,
    },
    imports: facts.imports.map((occurrence) =>
      resolveImport(source.path, occurrence, project.options, files, resolver, cache),
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
  const groups = new Map<string, ArchitectureImportDelta[]>()
  for (const fact of imports) {
    const target = fact.target
      ? (newModules.get(fact.target)?.group ??
        oldModules.get(fact.target)?.group ??
        posix.dirname(fact.target))
      : `${fact.resolution}: ${fact.specifier}`
    const source =
      newModules.get(fact.source)?.group ??
      oldModules.get(fact.source)?.group ??
      posix.dirname(fact.source)
    if (source === target) continue
    const key = JSON.stringify([source, target])
    groups.set(key, [...(groups.get(key) ?? []), fact])
  }
  const relationships = [...groups]
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

export function analyzeArchitecture(
  before: ArchitectureScanInput,
  after: ArchitectureScanInput,
): ArchitectureAnalysis {
  return compareArchitecture(scanArchitecture(before), scanArchitecture(after))
}
