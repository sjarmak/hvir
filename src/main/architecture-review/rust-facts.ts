import type { Node, Parser } from 'web-tree-sitter'
import { ARCHITECTURE_ANALYSIS_LIMITS } from '../../shared'
import type { ArchitectureModule } from '../../shared'
import type { ModuleFacts, ModuleImportOccurrence } from './module-facts'
import { lineOf, syntaxDiagnostics } from './tree-sitter-syntax'

/**
 * Bump whenever what `parseRustFacts` extracts changes. The scanner version adds a digest of
 * the runtime and grammar bytes, so a grammar upgrade changes it on its own.
 */
export const RUST_FACTS_REVISION = 'rust-facts-2'

type ModuleSymbol = ArchitectureModule['symbols'][number]

const ITEM_KINDS: Readonly<Record<string, string>> = {
  function_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  union_item: 'union',
  trait_item: 'trait',
  type_item: 'type',
  const_item: 'const',
  static_item: 'static',
  macro_definition: 'macro',
}
const DECLARATIONS: ReadonlySet<string> = new Set([
  'mod_item',
  'use_declaration',
  'extern_crate_declaration',
])

/**
 * One Rust source file's facts through tree-sitter; a syntax error is a diagnostic. Every
 * `mod name;`, `use` and `extern crate` is an occurrence in source order; resolution against
 * the crate's module tree happens per scan.
 */
export function parseRustFacts(parser: Parser, content: string): ModuleFacts {
  const tree = parser.parse(content)
  if (!tree) throw new Error('The Rust parser produced no syntax tree')
  try {
    const root = tree.rootNode
    return {
      symbols: root.namedChildren
        .flatMap(topLevelSymbol)
        .slice(0, ARCHITECTURE_ANALYSIS_LIMITS.maxSymbolsPerModule),
      imports: root.descendantsOfType([...DECLARATIONS]).flatMap(occurrence),
      diagnostics: syntaxDiagnostics(root),
    }
  } finally {
    tree.delete()
  }
}

/** Items at file level, plus inline modules; a file-backed `mod name;` is its own module. */
function topLevelSymbol(node: Node | null): ModuleSymbol[] {
  if (!node) return []
  const kind =
    node.type === 'mod_item'
      ? node.childForFieldName('body') && 'module'
      : ITEM_KINDS[node.type]
  const name = node.childForFieldName('name')
  return kind && name ? [{ name: unraw(name.text), line: lineOf(node), kind }] : []
}

function occurrence(node: Node): ModuleImportOccurrence[] {
  const scope = inlineScope(node)
  const position = {
    line: lineOf(node),
    column: node.startPosition.column + 1,
    typeOnly: false,
    ...(scope.length > 0 ? { scope } : {}),
  }
  if (node.type === 'extern_crate_declaration') {
    const name = node.childForFieldName('name')
    return name ? [{ specifier: unraw(name.text), form: 'import', ...position }] : []
  }
  if (node.type === 'mod_item') return modDeclaration(node, position)
  const argument = node.childForFieldName('argument')
  if (!argument) return []
  const exported = node.namedChildren.some(
    (child) => child?.type === 'visibility_modifier',
  )
  return [
    {
      specifier: argument.text.replace(/\s+/g, ' '),
      form: exported ? 'export' : 'import',
      names: useLeaves(argument, []).map((path) => path.join('::')),
      ...position,
    },
  ]
}

function modDeclaration(
  node: Node,
  position: Omit<ModuleImportOccurrence, 'form'>,
): ModuleImportOccurrence[] {
  const name = node.childForFieldName('name')
  if (!name || node.childForFieldName('body')) return []
  const pathAttribute = pathAttributeOf(node)
  return [
    {
      specifier: unraw(name.text),
      form: 'mod',
      ...position,
      ...(pathAttribute === undefined ? {} : { pathAttribute }),
    },
  ]
}

/** The names of the inline modules around a node, outermost first. */
function inlineScope(node: Node): string[] {
  const scope: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    const name = parent.type === 'mod_item' ? parent.childForFieldName('name') : null
    if (name) scope.unshift(unraw(name.text))
  }
  return scope
}

/** The `#[path = "..."]` among the attributes written directly above a declaration. */
function pathAttributeOf(node: Node): string | undefined {
  for (
    let sibling = node.previousNamedSibling;
    sibling?.type === 'attribute_item';
    sibling = sibling.previousNamedSibling
  ) {
    const attribute = sibling.namedChildren.find((child) => child?.type === 'attribute')
    const value = attribute?.childForFieldName('value')
    if (attribute?.namedChildren[0]?.text === 'path' && value?.type === 'string_literal')
      return value.namedChildren.find((child) => child?.type === 'string_content')?.text
  }
  return undefined
}

/**
 * Every path a use tree brings in, as segments: `a::{self, b::c as d, *}` gives `a::self`,
 * `a::b::c as d` and `a::*`, the alias kept because it is the name the module binds. A
 * leading `::` is an empty first segment.
 */
function useLeaves(node: Node, prefix: readonly string[]): string[][] {
  switch (node.type) {
    case 'scoped_use_list': {
      const path = node.childForFieldName('path')
      const list = node.childForFieldName('list')
      const base = path ? [...prefix, ...segments(path)] : prefix
      return list ? useLeaves(list, base) : []
    }
    case 'use_list':
      return node.namedChildren.flatMap((child) =>
        child ? useLeaves(child, prefix) : [],
      )
    case 'use_as_clause': {
      const path = node.childForFieldName('path')
      const alias = node.childForFieldName('alias')
      if (!path) return []
      const leaf = [...prefix, ...segments(path)]
      return alias
        ? [[...leaf.slice(0, -1), `${leaf.at(-1)} as ${unraw(alias.text)}`]]
        : [leaf]
    }
    case 'use_wildcard': {
      const path = node.namedChildren[0]
      return [[...prefix, ...(path ? segments(path) : []), '*']]
    }
    default:
      return [[...prefix, ...segments(node)]]
  }
}

const segments = (path: Node): string[] =>
  path.text.replace(/\s+/g, '').split('::').map(unraw)

/** `r#type` names the identifier `type`. */
const unraw = (name: string): string => (name.startsWith('r#') ? name.slice(2) : name)
