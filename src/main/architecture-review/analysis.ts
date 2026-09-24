import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import ts from 'typescript'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type {
  ArchitectureAnalysis,
  ArchitectureChange,
  ArchitectureImportDelta,
  ArchitectureImportFact,
  ArchitectureModule,
  ArchitectureModuleDelta,
  ArchitectureScanInput,
  ArchitectureScanResult,
} from '../../shared'

const VIRTUAL_ROOT = '/__architecture__'
const implementation = /\.[cm]?[jt]sx?$/
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

function compilerOptions(input: ArchitectureScanInput): ts.CompilerOptions {
  const converted = ts.convertCompilerOptionsFromJson(
    input.compilerOptions ?? {},
    '/__architecture__',
  )
  if (converted.errors.length)
    throw new Error(
      converted.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))
        .join('; '),
    )
  return {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    allowJs: true,
    ...converted.options,
  }
}

function group(path: string): string {
  const directory = posix.dirname(path)
  return directory === '.' ? '(repository root)' : directory
}

function scanImportFacts(
  file: ts.SourceFile,
  options: ts.CompilerOptions,
  files: ReadonlyMap<string, string>,
  host: ts.ModuleResolutionHost,
  cache: ts.ModuleResolutionCache,
): ArchitectureImportFact[] {
  const facts: ArchitectureImportFact[] = []
  const add = (
    node: ts.Node,
    expression: ts.Node | undefined,
    form: ArchitectureImportFact['form'],
    typeOnly: boolean,
  ) => {
    const point = file.getLineAndCharacterOfPosition(node.getStart(file))
    const literal =
      expression && (ts.isStringLiteralLike(expression) ? expression.text : undefined)
    const specifier = literal ?? '<computed>'
    const resolved = literal
      ? ts.resolveModuleName(
          literal,
          posix.join(VIRTUAL_ROOT, file.fileName),
          options,
          host,
          cache,
        ).resolvedModule
      : undefined
    const target = resolved
      ? posix.relative(VIRTUAL_ROOT, resolved.resolvedFileName)
      : undefined
    const local = Boolean(
      literal &&
      (literal.startsWith('.') ||
        literal.startsWith('/') ||
        literal.startsWith('#') ||
        Object.keys(options.paths ?? {}).some((pattern) => {
          const [prefix, suffix] = pattern.split('*')
          return suffix === undefined
            ? literal === prefix
            : literal.startsWith(prefix ?? '') && literal.endsWith(suffix ?? '')
        }) ||
        (options.baseUrl && !literal.startsWith('node:'))),
    )
    const resolution: ArchitectureImportFact['resolution'] =
      target && files.has(target)
        ? 'internal'
        : (literal && !local && !literal.startsWith('node:')) ||
            literal?.startsWith('node:')
          ? 'external'
          : 'unresolved'
    facts.push({
      source: file.fileName,
      ...(resolution === 'internal' ? { target } : {}),
      specifier,
      form,
      kind: typeOnly ? 'type-only' : 'runtime',
      resolution,
      line: point.line + 1,
      column: point.character + 1,
    })
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings
      const allType = Boolean(
        bindings &&
        ts.isNamedImports(bindings) &&
        !node.importClause?.name &&
        bindings.elements.length > 0 &&
        bindings.elements.every((entry) => entry.isTypeOnly),
      )
      add(
        node,
        node.moduleSpecifier,
        'import',
        Boolean(node.importClause?.isTypeOnly || allType),
      )
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      add(node, node.moduleSpecifier, 'export', Boolean(node.isTypeOnly))
    else if (ts.isImportTypeNode(node))
      add(
        node,
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        'import-type',
        true,
      )
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(
        node,
        node.moduleReference.expression,
        'import-equals',
        Boolean(node.isTypeOnly),
      )
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, node.arguments[0], 'dynamic-import', false)
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        add(node, node.arguments[0], 'require', false)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return facts
}

export function scanArchitecture(input: ArchitectureScanInput): ArchitectureScanResult {
  if (!input.scope.trim()) throw new Error('Architecture scan scope is required')
  const sorted = [...input.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const files = new Map(sorted.map((file) => [file.path, file.content]))
  const options = compilerOptions(input)
  const directories = new Set<string>(['', '.'])
  for (const path of files.keys()) {
    let directory = posix.dirname(path)
    while (!directories.has(directory)) {
      directories.add(directory)
      directory = posix.dirname(directory)
    }
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => files.has(posix.relative(VIRTUAL_ROOT, path)),
    readFile: (path) => files.get(posix.relative(VIRTUAL_ROOT, path)),
    directoryExists: (path) => directories.has(posix.relative(VIRTUAL_ROOT, path)),
    getCurrentDirectory: () => VIRTUAL_ROOT,
  }
  const cache = ts.createModuleResolutionCache(VIRTUAL_ROOT, (path) => path, options)
  const modules: ArchitectureModule[] = []
  const imports: ArchitectureImportFact[] = []
  const diagnostics: { file: string; line: number; message: string }[] = []
  if (!input.compilerOptions)
    diagnostics.push({
      file: '(capture)',
      line: 1,
      message:
        'Compiler options are not applied to this scan. Relative imports are resolved from captured files; bare specifiers are classified as external. Aliases and package exports may be unresolved or misclassified.',
    })
  for (const source of sorted) {
    if (!implementation.test(source.path)) continue
    const file = ts.createSourceFile(
      source.path,
      source.content,
      ts.ScriptTarget.Latest,
      true,
    )
    const parseDiagnostics =
      (file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics ?? []
    for (const diagnostic of parseDiagnostics) {
      const point = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      diagnostics.push({
        file: source.path,
        line: point.line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      })
    }
    const symbols: ArchitectureModule['symbols'][number][] = []
    const line = (node: ts.Node) =>
      file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    function collect(node: ts.Node): void {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node)) &&
        node.name
      )
        symbols.push({
          name: node.name.text,
          line: line(node),
          kind: ts.SyntaxKind[node.kind],
        })
      ts.forEachChild(node, collect)
    }
    collect(file)
    modules.push({
      path: source.path,
      group: group(source.path),
      hash: digest(source.content),
      symbols: symbols.slice(0, ARCHITECTURE_ANALYSIS_LIMITS.maxSymbolsPerModule),
    })
    imports.push(
      ...scanImportFacts(file, options, files, host, cache).slice(
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
  const fingerprint = digest(
    JSON.stringify({
      scope: input.scope,
      exclusions: [...input.exclusions],
      compilerOptions: input.compilerOptions ?? {},
      files: sorted,
    }),
  )
  return {
    fingerprint,
    scope: input.scope,
    exclusions: [...input.exclusions],
    modules,
    imports,
    diagnostics,
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
