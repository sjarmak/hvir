import type { Node, Parser } from 'web-tree-sitter'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type { ArchitectureModule } from '../../shared'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'

/**
 * Bump whenever what `parsePythonFacts` extracts changes. The scanner version adds a
 * digest of the runtime and grammar bytes, so a grammar upgrade changes it on its own.
 */
export const PYTHON_FACTS_REVISION = 'python-facts-1'

const IMPORTS = ['import_statement', 'import_from_statement', 'future_import_statement']
const SYMBOLS: Readonly<Record<string, string>> = {
  function_definition: 'function',
  class_definition: 'class',
}
const TYPE_CHECKING = new Set(['TYPE_CHECKING', 'typing.TYPE_CHECKING'])
const compact = (text: string): string => text.replace(/\s+/g, '')
const lineOf = (node: Node): number => node.startPosition.row + 1

/** One Python module's facts through tree-sitter; a syntax error is a diagnostic. */
export function parsePythonFacts(parser: Parser, content: string): ModuleFacts {
  const tree = parser.parse(content)
  if (!tree) throw new Error('The Python parser produced no syntax tree')
  try {
    const root = tree.rootNode
    return {
      symbols: moduleSymbols(root).slice(
        0,
        ARCHITECTURE_ANALYSIS_LIMITS.maxSymbolsPerModule,
      ),
      imports: root.descendantsOfType(IMPORTS).flatMap(importOccurrences),
      diagnostics: syntaxDiagnostics(root),
    }
  } finally {
    tree.delete()
  }
}

function moduleSymbols(root: Node): ArchitectureModule['symbols'][number][] {
  return root.descendantsOfType(Object.keys(SYMBOLS)).flatMap((node) => {
    const name = node.childForFieldName('name')
    return name
      ? [{ name: name.text, line: lineOf(node), kind: SYMBOLS[node.type]! }]
      : []
  })
}

function importOccurrences(statement: Node): ModuleImportOccurrence[] {
  const position = {
    typeOnly: underTypeChecking(statement),
    line: lineOf(statement),
    column: statement.startPosition.column + 1,
  }
  if (statement.type === 'import_statement')
    return statement.childrenForFieldName('name').map((name) => ({
      specifier: compact(importedName(name)),
      form: 'import',
      ...position,
    }))
  const module = statement.childForFieldName('module_name')
  const specifier =
    statement.type === 'future_import_statement'
      ? '__future__'
      : module && compact(module.text)
  if (!specifier) return []
  return [{ specifier, form: 'from-import', names: fromNames(statement), ...position }]
}

/** `a.b as c` imports `a.b`; the alias only names it locally. */
function importedName(node: Node): string {
  return node.type === 'aliased_import'
    ? (node.childForFieldName('name')?.text ?? node.text)
    : node.text
}

function fromNames(statement: Node): string[] {
  const names = statement
    .childrenForFieldName('name')
    .map((name) => compact(importedName(name)))
  const wildcard = statement.children.some((child) => child.type === 'wildcard_import')
  return wildcard ? [...names, '*'] : names
}

/** Inside `if TYPE_CHECKING:` an import exists for the type checker, not at run time. */
function underTypeChecking(node: Node): boolean {
  for (
    let child = node, parent = node.parent;
    parent;
    child = parent, parent = parent.parent
  ) {
    if (parent.type !== 'if_statement') continue
    const condition = parent.childForFieldName('condition')
    const consequence = parent.childForFieldName('consequence')
    if (
      condition &&
      consequence?.id === child.id &&
      TYPE_CHECKING.has(compact(condition.text))
    )
      return true
  }
  return false
}

/** The outermost ERROR and every MISSING node, in source order; only broken subtrees are walked. */
function syntaxDiagnostics(root: Node): { line: number; message: string }[] {
  const diagnostics: { line: number; message: string }[] = []
  const stack: Node[] = root.hasError ? [root] : []
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.isError) diagnostics.push({ line: lineOf(node), message: 'Syntax error' })
    else if (node.isMissing)
      diagnostics.push({ line: lineOf(node), message: `Missing ${node.type}` })
    else
      stack.push(
        ...node.children.filter((child) => child.hasError || child.isMissing).reverse(),
      )
  }
  return diagnostics
}
