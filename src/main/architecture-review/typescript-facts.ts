import ts from 'typescript'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type { ArchitectureImportForm, ArchitectureModule } from '../../shared'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'

/**
 * Names the parser that produced cached TypeScript facts. Bump the revision whenever what
 * `parseTypeScriptFacts` extracts changes; a TypeScript upgrade changes it on its own.
 */
export const TYPESCRIPT_SCANNER_VERSION = `typescript-facts-1+typescript-${ts.version}`

const KIND = /(?:\.d)?\.[cm]?[jt]sx?$/

/** The part of a path that changes how TypeScript parses it (`.ts`, `.tsx`, `.d.ts`...). */
export function typeScriptParseKind(path: string): string | undefined {
  return KIND.exec(path)?.[0]
}

export function parseTypeScriptFacts(path: string, content: string): ModuleFacts {
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
