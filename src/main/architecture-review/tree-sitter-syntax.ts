import type { Node } from 'web-tree-sitter'

/** The 1-based line a node starts on, as every scan fact records it. */
export const lineOf = (node: Node): number => node.startPosition.row + 1

/**
 * The outermost ERROR and every MISSING node of a tree-sitter parse, in source order. Only
 * broken subtrees are walked, so a clean module costs one flag read.
 */
export function syntaxDiagnostics(root: Node): { line: number; message: string }[] {
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
