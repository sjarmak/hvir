import type { Node, Parser } from 'web-tree-sitter'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type { ArchitectureModule } from '../../shared'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'
import { lineOf, syntaxDiagnostics } from './tree-sitter-syntax'

/**
 * Bump whenever what `parseGoFacts` extracts changes. The scanner version adds a digest of
 * the runtime and grammar bytes, so a grammar upgrade changes it on its own.
 */
export const GO_FACTS_REVISION = 'go-facts-1'

type ModuleSymbol = ArchitectureModule['symbols'][number]

const TYPE_SPECS: ReadonlySet<string> = new Set(['type_spec', 'type_alias'])
const PATH_CONTENT: ReadonlySet<string> = new Set([
  'interpreted_string_literal_content',
  'raw_string_literal_content',
])

/** One Go source file's facts through tree-sitter; a syntax error is a diagnostic. */
export function parseGoFacts(parser: Parser, content: string): ModuleFacts {
  const tree = parser.parse(content)
  if (!tree) throw new Error('The Go parser produced no syntax tree')
  try {
    const root = tree.rootNode
    return {
      symbols: root.namedChildren
        .flatMap(topLevelSymbols)
        .slice(0, ARCHITECTURE_ANALYSIS_LIMITS.maxSymbolsPerModule),
      imports: root.descendantsOfType('import_spec').flatMap(importOccurrence),
      diagnostics: syntaxDiagnostics(root),
    }
  } finally {
    tree.delete()
  }
}

/** Package-level declarations only; a type declared inside a function is not API. */
function topLevelSymbols(node: Node | null): ModuleSymbol[] {
  if (!node) return []
  if (node.type === 'function_declaration') return named(node, 'function')
  if (node.type === 'method_declaration') return named(node, 'method')
  if (node.type !== 'type_declaration') return []
  return node.namedChildren.flatMap((spec) =>
    spec && TYPE_SPECS.has(spec.type) ? named(spec, 'type') : [],
  )
}

function named(node: Node, kind: string): ModuleSymbol[] {
  const name = node.childForFieldName('name')
  return name ? [{ name: name.text, line: lineOf(node), kind }] : []
}

/** Each spec is its own occurrence, so evidence points at the line that names the path. */
function importOccurrence(spec: Node): ModuleImportOccurrence[] {
  const path = spec.childForFieldName('path')
  const literal = path?.namedChildren.find(
    (child) => child && PATH_CONTENT.has(child.type),
  )
  if (!literal) return []
  return [
    {
      specifier: literal.text,
      form: 'import',
      typeOnly: false,
      line: lineOf(spec),
      column: spec.startPosition.column + 1,
    },
  ]
}
