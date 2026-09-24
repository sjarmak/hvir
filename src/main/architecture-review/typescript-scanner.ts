import { posix } from 'node:path'
import ts from 'typescript'
import type { ArchitectureImportFact, ArchitectureSourceFile } from '../../shared'
import { loadCompilerSettings, VIRTUAL_ROOT } from './compiler-config'
import {
  scannerSet,
  type LanguageScanner,
  type ResolutionContext,
  type ScanResolver,
} from './language-scanner'
import type { ModuleImportOccurrence } from './module-facts'
import {
  parseTypeScriptFacts,
  typeScriptParseKind,
  TYPESCRIPT_SCANNER_VERSION,
} from './typescript-facts'

/** TypeScript and JavaScript through the compiler, with the captured tsconfig applied. */
export const TYPESCRIPT_SCANNER: LanguageScanner = {
  language: 'typescript',
  version: TYPESCRIPT_SCANNER_VERSION,
  kindOf: typeScriptParseKind,
  parse: parseTypeScriptFacts,
  resolver: typeScriptResolver,
}

/** For callers that never load grammars; any other language is disclosed as unscanned. */
export const TYPESCRIPT_ONLY_SCANNERS = scannerSet([TYPESCRIPT_SCANNER])

function typeScriptResolver({ modules, configs }: ResolutionContext): ScanResolver {
  const settings = loadCompilerSettings(configs, [...modules.keys()])
  const resolver = moduleResolver(modules, configs)
  return {
    diagnostics: settings.diagnostics,
    resolve: (source, occurrence) => {
      const project = settings.projectFor(source)
      const cache = resolver.cacheFor(project.config, project.options)
      return [
        resolveImport(source, occurrence, project.options, modules, resolver, cache),
      ]
    },
  }
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

interface ModuleResolver {
  readonly host: ts.ModuleResolutionHost
  readonly cacheFor: (
    config: string | undefined,
    options: ts.CompilerOptions,
  ) => ts.ModuleResolutionCache
}

/** Resolution sees every captured source and config, and caches per governing project. */
function moduleResolver(
  files: ReadonlyMap<string, string>,
  configs: readonly ArchitectureSourceFile[],
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
  return { host, cacheFor }
}
