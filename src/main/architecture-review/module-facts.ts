import ts from 'typescript'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type { ArchitectureImportForm, ArchitectureModule } from '../../shared'

/**
 * Names the parser that produced cached facts. Bump the revision whenever what
 * `parseModuleFacts` extracts changes; a TypeScript upgrade changes it on its own.
 */
export const ARCHITECTURE_SCANNER_VERSION = `module-facts-1+typescript-${ts.version}`

/** One import as written in a module, before it is resolved against any file set. */
export interface ModuleImportOccurrence {
  /** Absent for a computed specifier such as `import(name)`. */
  readonly specifier?: string
  readonly form: ArchitectureImportForm
  readonly typeOnly: boolean
  readonly line: number
  readonly column: number
}

/**
 * Everything a scan learns from one module's bytes alone. It depends only on the content
 * and the parse kind, so it can be cached by blob id; resolution happens per scan.
 */
export interface ModuleFacts {
  readonly symbols: ArchitectureModule['symbols']
  readonly imports: readonly ModuleImportOccurrence[]
  readonly diagnostics: readonly { readonly line: number; readonly message: string }[]
}

const KIND = /(?:\.d)?\.[cm]?[jt]sx?$/

/** The part of a path that changes how TypeScript parses it: `.ts`, `.tsx`, `.d.ts`... */
export function parseKind(path: string): string {
  const kind = KIND.exec(path)?.[0]
  if (!kind) throw new Error(`Not a scannable module: ${path}`)
  return kind
}

export function parseModuleFacts(path: string, content: string): ModuleFacts {
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
  const parseDiagnostics =
    (file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? []
  return {
    symbols: moduleSymbols(file).slice(
      0,
      ARCHITECTURE_ANALYSIS_LIMITS.maxSymbolsPerModule,
    ),
    imports: importOccurrences(file),
    diagnostics: parseDiagnostics.map((diagnostic) => ({
      line: lineOf(file, diagnostic.start ?? 0),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    })),
  }
}

const lineOf = (file: ts.SourceFile, position: number): number =>
  file.getLineAndCharacterOfPosition(position).line + 1

function moduleSymbols(file: ts.SourceFile): ArchitectureModule['symbols'][number][] {
  const symbols: ArchitectureModule['symbols'][number][] = []
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
        line: lineOf(file, node.getStart(file)),
        kind: ts.SyntaxKind[node.kind],
      })
    ts.forEachChild(node, collect)
  }
  collect(file)
  return symbols
}

function importOccurrences(file: ts.SourceFile): ModuleImportOccurrence[] {
  const found: ModuleImportOccurrence[] = []
  const add = (
    node: ts.Node,
    expression: ts.Node | undefined,
    form: ArchitectureImportForm,
    typeOnly: boolean,
  ) => {
    const point = file.getLineAndCharacterOfPosition(node.getStart(file))
    const literal =
      expression && ts.isStringLiteralLike(expression) ? expression.text : undefined
    found.push({
      ...(literal === undefined ? {} : { specifier: literal }),
      form,
      typeOnly,
      line: point.line + 1,
      column: point.character + 1,
    })
  }
  const visit = (node: ts.Node): void => {
    visitImport(node, add)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

type AddImport = (
  node: ts.Node,
  expression: ts.Node | undefined,
  form: ArchitectureImportForm,
  typeOnly: boolean,
) => void

function visitImport(node: ts.Node, add: AddImport): void {
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
    add(node, node.moduleReference.expression, 'import-equals', Boolean(node.isTypeOnly))
  else if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
      add(node, node.arguments[0], 'dynamic-import', false)
    else if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      add(node, node.arguments[0], 'require', false)
  }
}

const FORMS: ReadonlySet<string> = new Set<ArchitectureImportForm>([
  'import',
  'export',
  'import-type',
  'import-equals',
  'dynamic-import',
  'require',
])
const isPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Structural check for facts read back from disk; anything else is discarded. */
export function isModuleFacts(value: unknown): value is ModuleFacts {
  if (!isRecord(value)) return false
  const { symbols, imports, diagnostics } = value
  return (
    Array.isArray(symbols) &&
    symbols.every(
      (symbol) =>
        isRecord(symbol) &&
        typeof symbol.name === 'string' &&
        typeof symbol.kind === 'string' &&
        isPosition(symbol.line),
    ) &&
    Array.isArray(imports) &&
    imports.every(
      (entry) =>
        isRecord(entry) &&
        (entry.specifier === undefined || typeof entry.specifier === 'string') &&
        typeof entry.form === 'string' &&
        FORMS.has(entry.form) &&
        typeof entry.typeOnly === 'boolean' &&
        isPosition(entry.line) &&
        isPosition(entry.column),
    ) &&
    Array.isArray(diagnostics) &&
    diagnostics.every(
      (entry) =>
        isRecord(entry) && typeof entry.message === 'string' && isPosition(entry.line),
    )
  )
}
