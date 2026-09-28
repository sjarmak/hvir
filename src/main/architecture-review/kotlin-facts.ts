import type { Node, Parser } from 'web-tree-sitter'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type { ArchitectureModule } from '../../shared'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'
import { lineOf, syntaxDiagnostics } from './tree-sitter-syntax'

export const KOTLIN_FACTS_REVISION = 'kotlin-facts-1'

const DECLARATIONS: Readonly<Record<string, string>> = {
  class_declaration: 'class',
  function_declaration: 'function',
  object_declaration: 'object',
  type_alias: 'type',
  property_declaration: 'property',
}

export function parseKotlinFacts(parser: Parser, content: string): ModuleFacts {
  const tree = parser.parse(content)
  if (!tree) throw new Error('The Kotlin parser produced no syntax tree')
  try {
    const root = tree.rootNode
    const header = root.namedChildren.find((node) => node?.type === 'package_header')
    const packageName = header?.namedChildren[0]?.text
    const declarations = root.namedChildren.flatMap((node) =>
      node ? topLevelSymbol(node) : [],
    )
    return {
      ...(packageName ? { packageName } : {}),
      resolutionSymbols: declarations.map(({ name }) => name),
      symbols: declarations.slice(0, ARCHITECTURE_ANALYSIS_LIMITS.maxSymbolsPerModule),
      imports: root.namedChildren
        .filter((node): node is Node => node?.type === 'import')
        .flatMap(importOccurrence),
      diagnostics: syntaxDiagnostics(root),
    }
  } finally {
    tree.delete()
  }
}

function topLevelSymbol(node: Node): ArchitectureModule['symbols'] {
  const kind = DECLARATIONS[node.type]
  if (!kind) return []
  const name =
    node.childForFieldName('name') ??
    (node.type === 'property_declaration'
      ? node.namedChildren.find((child) => child?.type === 'variable_declaration')
          ?.namedChildren[0]
      : node.namedChildren[0])
  return name && name.type === 'identifier'
    ? [{ name: name.text, line: lineOf(node), kind }]
    : []
}

function importOccurrence(node: Node): ModuleImportOccurrence[] {
  const qualified = node.namedChildren.find(
    (child) => child?.type === 'qualified_identifier' || child?.type === 'identifier',
  )
  if (!qualified) return []
  const specifier = qualified.text
  const wildcard = /\.\s*\*$/.test(node.text)
  return [
    {
      specifier,
      form: 'import',
      names: wildcard ? ['*'] : undefined,
      typeOnly: false,
      line: lineOf(node),
      column: node.startPosition.column + 1,
    },
  ]
}
